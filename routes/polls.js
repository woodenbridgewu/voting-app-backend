const express = require('express');
const Joi = require('joi');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { pool } = require('../config/database');
const { getCachedPollResults, cachePollResults } = require('../config/redis');
const { authenticateToken, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// Validation schemas
const createPollSchema = Joi.object({
    title: Joi.string().min(3).max(200).required(),
    description: Joi.string().max(1000).optional(),
    endDate: Joi.date().greater('now').optional(),
    options: Joi.array().items(
        Joi.object({
            text: Joi.string().min(1).max(100).required(),
            hasImage: Joi.boolean().optional()
        })
    ).min(2).max(10).required()
});

// Helper function to upload image to Cloudinary
const uploadToCloudinary = (buffer, folder = 'voting-app') => {
    return new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
            {
                folder,
                resource_type: 'image',
                transformation: [
                    { width: 800, height: 600, crop: 'limit' },
                    { quality: 'auto', fetch_format: 'auto' }
                ]
            },
            (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }
        ).end(buffer);
    });
};

// Create a new poll
router.post('/', authenticateToken, upload.array('images', 10), async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Parse and validate the main poll data
        const pollData = JSON.parse(req.body.pollData || '{}');
        const { error, value } = createPollSchema.validate(pollData);

        if (error) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: error.details[0].message });
        }

        const { title, description, endDate, options } = value;
        const creatorId = req.user.userId;

        // Create the poll
        const pollResult = await client.query(
            `INSERT INTO polls (title, description, creator_id, end_date, is_active) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, title, description, start_date, end_date, is_active, created_at`,
            [title, description || null, creatorId, endDate || null, true]
        );

        const poll = pollResult.rows[0];
        const images = req.files || [];
        let imageIndex = 0;

        // Create poll options
        const createdOptions = [];
        for (let i = 0; i < options.length; i++) {
            const option = options[i];
            let imageUrl = null;

            // If this option should have an image and we have images available
            if (option.hasImage && imageIndex < images.length) {
                try {
                    const uploadResult = await uploadToCloudinary(images[imageIndex].buffer);
                    imageUrl = uploadResult.secure_url;
                    imageIndex++;
                } catch (uploadError) {
                    console.error('Image upload error:', uploadError);
                    // Continue without image rather than failing the whole request
                }
            }

            const optionResult = await client.query(
                `INSERT INTO poll_options (poll_id, text, image_url) 
         VALUES ($1, $2, $3) 
         RETURNING id, text, image_url, vote_count`,
                [poll.id, option.text, imageUrl]
            );

            createdOptions.push(optionResult.rows[0]);
        }

        await client.query('COMMIT');

        res.status(201).json({
            message: 'Poll created successfully',
            poll: {
                ...poll,
                options: createdOptions
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Create poll error:', error);
        res.status(500).json({ error: 'Failed to create poll' });
    } finally {
        client.release();
    }
});

// Get all polls (with pagination)
router.get('/', optionalAuth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const sortBy = req.query.sortBy || 'created_at';
        const sortOrder = req.query.sortOrder || 'DESC';
        const isActive = req.query.active !== 'false';

        // Build where clause
        let whereClause = 'WHERE p.is_active = $1';
        const queryParams = [isActive];
        let paramCount = 2;

        if (search) {
            whereClause += ` AND (p.title ILIKE $${paramCount} OR p.description ILIKE $${paramCount})`;
            queryParams.push(`%${search}%`);
            paramCount++;
        }

        // Valid sort columns
        const validSortColumns = ['created_at', 'title', 'start_date'];
        const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
        const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        // Get total count
        const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM polls p
      JOIN users u ON p.creator_id = u.id
      ${whereClause}
    `, queryParams);

        const total = parseInt(countResult.rows[0].total);

        // Get polls with creator info
        queryParams.push(limit, offset);
        const pollsResult = await pool.query(`
      SELECT 
        p.id, p.title, p.description, p.start_date, p.end_date, p.is_active, p.created_at,
        u.name as creator_name,
        COUNT(vr.id) as total_votes
      FROM polls p
      JOIN users u ON p.creator_id = u.id
      LEFT JOIN vote_records vr ON p.id = vr.poll_id
      ${whereClause}
      GROUP BY p.id, u.name
      ORDER BY p.${sortColumn} ${order}
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `, queryParams);

        // Get options for each poll
        const polls = [];
        for (const poll of pollsResult.rows) {
            const optionsResult = await pool.query(`
        SELECT id, text, image_url, vote_count
        FROM poll_options
        WHERE poll_id = $1
        ORDER BY created_at
      `, [poll.id]);

            polls.push({
                ...poll,
                totalVotes: parseInt(poll.total_votes),
                options: optionsResult.rows
            });
        }

        res.json({
            polls,
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
        console.error('Get polls error:', error);
        res.status(500).json({ error: 'Failed to fetch polls' });
    }
});

// Get single poll by ID
router.get('/:id', optionalAuth, async (req, res) => {
    try {
        const pollId = req.params.id;

        // Check cache first
        const cachedResults = await getCachedPollResults(pollId);
        if (cachedResults) {
            return res.json(cachedResults);
        }

        // Get poll details
        const pollResult = await pool.query(`
      SELECT 
        p.id, p.title, p.description, p.start_date, p.end_date, p.is_active, p.created_at,
        u.name as creator_name, u.id as creator_id
      FROM polls p
      JOIN users u ON p.creator_id = u.id
      WHERE p.id = $1
    `, [pollId]);

        if (pollResult.rows.length === 0) {
            return res.status(404).json({ error: 'Poll not found' });
        }

        const poll = pollResult.rows[0];

        // Get poll options with vote counts
        const optionsResult = await pool.query(`
      SELECT 
        po.id, po.text, po.image_url, po.vote_count,
        COUNT(vr.id) as actual_vote_count
      FROM poll_options po
      LEFT JOIN vote_records vr ON po.id = vr.option_id
      WHERE po.poll_id = $1
      GROUP BY po.id, po.text, po.image_url, po.vote_count
      ORDER BY po.created_at
    `, [pollId]);

        // Get total votes
        const totalVotesResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM vote_records
      WHERE poll_id = $1
    `, [pollId]);

        const totalVotes = parseInt(totalVotesResult.rows[0].total);

        // Check if current user has voted today (if authenticated)
        let hasVotedToday = false;
        if (req.user) {
            const todayVoteResult = await pool.query(`
        SELECT id FROM vote_records
        WHERE user_id = $1 AND poll_id = $2 AND DATE(voted_at) = CURRENT_DATE
      `, [req.user.userId, pollId]);

            hasVotedToday = todayVoteResult.rows.length > 0;
        }

        const result = {
            poll: {
                ...poll,
                totalVotes,
                hasVotedToday,
                canEdit: req.user?.userId === poll.creator_id,
                options: optionsResult.rows.map(option => ({
                    id: option.id,
                    text: option.text,
                    imageUrl: option.image_url,
                    voteCount: parseInt(option.actual_vote_count),
                    percentage: totalVotes > 0 ? Math.round((option.actual_vote_count / totalVotes) * 100) : 0
                }))
            }
        };

        // Cache the results for 5 minutes
        await cachePollResults(pollId, result, 300);

        res.json(result);

    } catch (error) {
        console.error('Get poll error:', error);
        res.status(500).json({ error: 'Failed to fetch poll' });
    }
});

// Get polls created by current user
router.get('/my/polls', authenticateToken, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        // Get total count
        const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM polls
      WHERE creator_id = $1
    `, [req.user.userId]);

        const total = parseInt(countResult.rows[0].total);

        // Get user's polls
        const pollsResult = await pool.query(`
      SELECT 
        p.id, p.title, p.description, p.start_date, p.end_date, p.is_active, p.created_at,
        COUNT(vr.id) as total_votes
      FROM polls p
      LEFT JOIN vote_records vr ON p.id = vr.poll_id
      WHERE p.creator_id = $1
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.user.userId, limit, offset]);

        // Get options for each poll
        const polls = [];
        for (const poll of pollsResult.rows) {
            const optionsResult = await pool.query(`
        SELECT id, text, image_url, vote_count
        FROM poll_options
        WHERE poll_id = $1
        ORDER BY created_at
      `, [poll.id]);

            polls.push({
                ...poll,
                totalVotes: parseInt(poll.total_votes),
                options: optionsResult.rows
            });
        }

        res.json({
            polls,
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
        console.error('Get my polls error:', error);
        res.status(500).json({ error: 'Failed to fetch your polls' });
    }
});

// Update poll (only by creator)
router.put('/:id', authenticateToken, async (req, res) => {
    try {
        const pollId = req.params.id;
        const updateSchema = Joi.object({
            title: Joi.string().min(3).max(200).optional(),
            description: Joi.string().max(1000).optional().allow(''),
            endDate: Joi.date().greater('now').optional().allow(null),
            isActive: Joi.boolean().optional()
        });

        const { error, value } = updateSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ error: error.details[0].message });
        }

        // Check if poll exists and user is the creator
        const pollResult = await pool.query(`
      SELECT id, creator_id FROM polls WHERE id = $1
    `, [pollId]);

        if (pollResult.rows.length === 0) {
            return res.status(404).json({ error: 'Poll not found' });
        }

        if (pollResult.rows[0].creator_id !== req.user.userId) {
            return res.status(403).json({ error: 'Only the poll creator can update this poll' });
        }

        // Build update query
        const updates = [];
        const values = [];
        let paramCount = 1;

        Object.keys(value).forEach(key => {
            if (value[key] !== undefined) {
                const dbKey = key === 'endDate' ? 'end_date' :
                    key === 'isActive' ? 'is_active' : key;
                updates.push(`${dbKey} = ${paramCount++}`);
                values.push(value[key]);
            }
        });

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(pollId);

        const query = `
      UPDATE polls 
      SET ${updates.join(', ')} 
      WHERE id = ${paramCount}
      RETURNING id, title, description, start_date, end_date, is_active, updated_at
    `;

        const result = await pool.query(query, values);

        res.json({
            message: 'Poll updated successfully',
            poll: result.rows[0]
        });

    } catch (error) {
        console.error('Update poll error:', error);
        res.status(500).json({ error: 'Failed to update poll' });
    }
});

// Delete poll (only by creator)
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const pollId = req.params.id;

        // Check if poll exists and user is the creator
        const pollResult = await pool.query(`
      SELECT id, creator_id FROM polls WHERE id = $1
    `, [pollId]);

        if (pollResult.rows.length === 0) {
            return res.status(404).json({ error: 'Poll not found' });
        }

        if (pollResult.rows[0].creator_id !== req.user.userId) {
            return res.status(403).json({ error: 'Only the poll creator can delete this poll' });
        }

        // Delete poll (cascading will handle related records)
        await pool.query('DELETE FROM polls WHERE id = $1', [pollId]);

        res.json({ message: 'Poll deleted successfully' });

    } catch (error) {
        console.error('Delete poll error:', error);
        res.status(500).json({ error: 'Failed to delete poll' });
    }
});

module.exports = router;