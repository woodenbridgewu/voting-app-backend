const express = require('express');
const Joi = require('joi');
const { pool, updateVoteCount } = require('../config/database');
const { hasVotedToday, markAsVoted, cachePollResults, getClient } = require('../config/redis');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Validation schema
const voteSchema = Joi.object({
    pollId: Joi.string().uuid().required(),
    optionId: Joi.string().uuid().required()
});

// Cast a vote
router.post('/', authenticateToken, async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Validate input
        const { error, value } = voteSchema.validate(req.body);
        if (error) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: error.details[0].message });
        }

        const { pollId, optionId } = value;
        const userId = req.user.userId;

        // Check if poll exists and is active
        const pollResult = await client.query(`
      SELECT id, title, is_active, end_date
      FROM polls 
      WHERE id = $1
    `, [pollId]);

        if (pollResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Poll not found' });
        }

        const poll = pollResult.rows[0];

        if (!poll.is_active) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'This poll is no longer active' });
        }

        // Check if poll has ended
        if (poll.end_date && new Date(poll.end_date) < new Date()) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'This poll has ended' });
        }

        // Check if option belongs to this poll
        const optionResult = await client.query(`
      SELECT id FROM poll_options 
      WHERE id = $1 AND poll_id = $2
    `, [optionId, pollId]);

        if (optionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid poll option' });
        }

        // Check if user has already voted today using Redis
        const votedToday = await hasVotedToday(userId, pollId);
        if (votedToday) {
            await client.query('ROLLBACK');
            return res.status(429).json({ error: 'You can only vote once per day for this poll' });
        }

        // Double-check with database (in case Redis is down)
        const existingVoteResult = await client.query(`
      SELECT id FROM vote_records 
      WHERE user_id = $1 AND poll_id = $2 AND DATE(voted_at) = CURRENT_DATE
    `, [userId, pollId]);

        if (existingVoteResult.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(429).json({ error: 'You have already voted for this poll today' });
        }

        // Record the vote
        const voteResult = await client.query(`
      INSERT INTO vote_records (user_id, poll_id, option_id)
      VALUES ($1, $2, $3)
      RETURNING id, voted_at
    `, [userId, pollId, optionId]);

        const vote = voteResult.rows[0];

        // Update vote count in poll_options table
        await updateVoteCount(optionId);

        // Mark user as voted in Redis
        await markAsVoted(userId, pollId);

        await client.query('COMMIT');

        // Clear cached poll results
        try {
            const redisClient = getClient();
            if (redisClient && redisClient.isReady) {
                const key = `poll_results:${pollId}`;
                await redisClient.del(key);
            }
        } catch (error) {
            console.error('Failed to clear cache:', error);
        }

        res.status(201).json({
            message: 'Vote recorded successfully',
            vote: {
                id: vote.id,
                pollId,
                optionId,
                votedAt: vote.voted_at
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Vote error:', error);

        if (error.code === '23505') { // Unique constraint violation
            res.status(429).json({ error: 'You have already voted for this poll today' });
        } else {
            res.status(500).json({ error: 'Failed to record vote' });
        }
    } finally {
        client.release();
    }
});

// Get user's vote history
router.get('/history', authenticateToken, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const userId = req.user.userId;

        // Get total count
        const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM vote_records vr
      JOIN polls p ON vr.poll_id = p.id
      WHERE vr.user_id = $1
    `, [userId]);

        const total = parseInt(countResult.rows[0].total);

        // Get vote history
        const historyResult = await pool.query(`
      SELECT 
        vr.id, vr.voted_at,
        p.id as poll_id, p.title as poll_title,
        po.id as option_id, po.text as option_text, po.image_url as option_image
      FROM vote_records vr
      JOIN polls p ON vr.poll_id = p.id
      JOIN poll_options po ON vr.option_id = po.id
      WHERE vr.user_id = $1
      ORDER BY vr.voted_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

        const votes = historyResult.rows.map(vote => ({
            id: vote.id,
            votedAt: vote.voted_at,
            poll: {
                id: vote.poll_id,
                title: vote.poll_title
            },
            option: {
                id: vote.option_id,
                text: vote.option_text,
                imageUrl: vote.option_image
            }
        }));

        res.json({
            votes,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasNext: page < Math.ceil(total / limit),
                hasPrev: page > 1
            }
        });

    } catch (error) {
        console.error('Vote history error:', error);
        res.status(500).json({ error: 'Failed to fetch vote history' });
    }
});

// Get votes for a specific poll (for poll creators)
router.get('/poll/:pollId', authenticateToken, async (req, res) => {
    try {
        const pollId = req.params.pollId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        // Check if user is the poll creator
        const pollResult = await pool.query(`
      SELECT creator_id FROM polls WHERE id = $1
    `, [pollId]);

        if (pollResult.rows.length === 0) {
            return res.status(404).json({ error: 'Poll not found' });
        }

        if (pollResult.rows[0].creator_id !== req.user.userId) {
            return res.status(403).json({ error: 'Only the poll creator can view detailed vote information' });
        }

        // Get total vote count
        const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM vote_records
      WHERE poll_id = $1
    `, [pollId]);

        const total = parseInt(countResult.rows[0].total);

        // Get detailed vote information
        const votesResult = await pool.query(`
      SELECT 
        vr.id, vr.voted_at,
        u.name as voter_name, u.email as voter_email,
        po.text as option_text, po.image_url as option_image
      FROM vote_records vr
      JOIN users u ON vr.user_id = u.id
      JOIN poll_options po ON vr.option_id = po.id
      WHERE vr.poll_id = $1
      ORDER BY vr.voted_at DESC
      LIMIT $2 OFFSET $3
    `, [pollId, limit, offset]);

        const votes = votesResult.rows.map(vote => ({
            id: vote.id,
            votedAt: vote.voted_at,
            voter: {
                name: vote.voter_name,
                email: vote.voter_email
            },
            option: {
                text: vote.option_text,
                imageUrl: vote.option_image
            }
        }));

        res.json({
            votes,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasNext: page < Math.ceil(total / limit),
                hasPrev: page > 1
            }
        });

    } catch (error) {
        console.error('Poll votes error:', error);
        res.status(500).json({ error: 'Failed to fetch poll votes' });
    }
});

// Get voting statistics for a poll (for poll creators)
router.get('/stats/:pollId', authenticateToken, async (req, res) => {
    try {
        const pollId = req.params.pollId;

        // Check if user is the poll creator
        const pollResult = await pool.query(`
      SELECT creator_id, title FROM polls WHERE id = $1
    `, [pollId]);

        if (pollResult.rows.length === 0) {
            return res.status(404).json({ error: 'Poll not found' });
        }

        if (pollResult.rows[0].creator_id !== req.user.userId) {
            return res.status(403).json({ error: 'Only the poll creator can view poll statistics' });
        }

        // Get daily vote counts for the last 30 days
        const dailyStatsResult = await pool.query(`
      SELECT 
        DATE(voted_at) as vote_date,
        COUNT(*) as vote_count
      FROM vote_records
      WHERE poll_id = $1 
        AND voted_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE(voted_at)
      ORDER BY vote_date DESC
    `, [pollId]);

        // Get option statistics
        const optionStatsResult = await pool.query(`
      SELECT 
        po.id, po.text, po.image_url,
        COUNT(vr.id) as vote_count,
        ROUND(
          (COUNT(vr.id)::float / NULLIF(
            (SELECT COUNT(*) FROM vote_records WHERE poll_id = $1), 0
          )) * 100, 2
        ) as percentage
      FROM poll_options po
      LEFT JOIN vote_records vr ON po.id = vr.option_id
      WHERE po.poll_id = $1
      GROUP BY po.id, po.text, po.image_url
      ORDER BY vote_count DESC
    `, [pollId]);

        // Get total statistics
        const totalStatsResult = await pool.query(`
      SELECT 
        COUNT(DISTINCT user_id) as unique_voters,
        COUNT(*) as total_votes,
        MIN(voted_at) as first_vote,
        MAX(voted_at) as last_vote
      FROM vote_records
      WHERE poll_id = $1
    `, [pollId]);

        const totalStats = totalStatsResult.rows[0];

        res.json({
            pollTitle: pollResult.rows[0].title,
            totalStats: {
                uniqueVoters: parseInt(totalStats.unique_voters || 0),
                totalVotes: parseInt(totalStats.total_votes || 0),
                firstVote: totalStats.first_vote,
                lastVote: totalStats.last_vote
            },
            dailyStats: dailyStatsResult.rows.map(stat => ({
                date: stat.vote_date,
                voteCount: parseInt(stat.vote_count)
            })),
            optionStats: optionStatsResult.rows.map(stat => ({
                id: stat.id,
                text: stat.text,
                imageUrl: stat.image_url,
                voteCount: parseInt(stat.vote_count),
                percentage: parseFloat(stat.percentage || 0)
            }))
        });

    } catch (error) {
        console.error('Poll stats error:', error);
        res.status(500).json({ error: 'Failed to fetch poll statistics' });
    }
});

// Check if user can vote for a poll
router.get('/can-vote/:pollId', authenticateToken, async (req, res) => {
    try {
        const pollId = req.params.pollId;
        const userId = req.user.userId;

        // Check if poll exists and is active
        const pollResult = await pool.query(`
      SELECT is_active, end_date FROM polls WHERE id = $1
    `, [pollId]);

        if (pollResult.rows.length === 0) {
            return res.status(404).json({ error: 'Poll not found' });
        }

        const poll = pollResult.rows[0];

        if (!poll.is_active) {
            return res.json({ canVote: false, reason: 'Poll is not active' });
        }

        if (poll.end_date && new Date(poll.end_date) < new Date()) {
            return res.json({ canVote: false, reason: 'Poll has ended' });
        }

        // Check if user has voted today
        const votedToday = await hasVotedToday(userId, pollId);
        if (votedToday) {
            return res.json({ canVote: false, reason: 'Already voted today' });
        }

        // Double-check with database
        const existingVoteResult = await pool.query(`
      SELECT id FROM vote_records 
      WHERE user_id = $1 AND poll_id = $2 AND DATE(voted_at) = CURRENT_DATE
    `, [userId, pollId]);

        if (existingVoteResult.rows.length > 0) {
            return res.json({ canVote: false, reason: 'Already voted today' });
        }

        res.json({ canVote: true });

    } catch (error) {
        console.error('Can vote check error:', error);
        res.status(500).json({ error: 'Failed to check voting eligibility' });
    }
});

module.exports = router;