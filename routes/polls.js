const express = require('express');
const Joi = require('joi');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { pool } = require('../config/database');
const { getCachedPollResults, cachePollResults, hasVotedToday } = require('../config/redis');
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
            description: Joi.string().max(500).allow('').optional(),
            imageCount: Joi.number().min(0).max(10).optional()
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

// Create a new poll (supports single cover image + multiple option images)
router.post('/', authenticateToken, upload.fields([
    { name: 'coverImage', maxCount: 1 },
    { name: 'images', maxCount: 100 } // Allow up to 100 images total (10 per option * 10 options)
]), async (req, res) => {
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

        // Handle cover image upload if provided
        let coverImageUrl = null;
        const coverFiles = (req.files && req.files['coverImage']) || [];
        if (coverFiles.length > 0) {
            try {
                const uploadResult = await uploadToCloudinary(coverFiles[0].buffer, 'voting-app/covers');
                coverImageUrl = uploadResult.secure_url;
            } catch (uploadError) {
                console.error('Cover image upload error:', uploadError);
            }
        }

        // Create the poll
        const pollResult = await client.query(
            `INSERT INTO polls (title, description, creator_id, end_date, is_active, image_url) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, title, description, start_date, end_date, is_active, image_url, created_at`,
            [title, description || null, creatorId, endDate || null, true, coverImageUrl]
        );

        const poll = pollResult.rows[0];
        const images = (req.files && req.files['images']) || [];
        let imageIndex = 0;

        // Create poll options
        const createdOptions = [];
        for (let i = 0; i < options.length; i++) {
            const option = options[i];
            
            // Create the option first
            const optionResult = await client.query(
                `INSERT INTO poll_options (poll_id, text, description) 
         VALUES ($1, $2, $3) 
         RETURNING id, text, description, vote_count`,
                [poll.id, option.text, option.description || null]
            );

            const createdOption = optionResult.rows[0];
            
            // Handle multiple images for this option
            const optionImageCount = option.imageCount || 0;
            const optionImages = [];
            
            for (let j = 0; j < optionImageCount && imageIndex < images.length; j++) {
                try {
                    const uploadResult = await uploadToCloudinary(images[imageIndex].buffer);
                    optionImages.push({
                        imageUrl: uploadResult.secure_url,
                        isPrimary: j === 0, // First image is primary
                        displayOrder: j
                    });
                    imageIndex++;
                } catch (uploadError) {
                    console.error('Image upload error:', uploadError);
                    // Continue without this image
                }
            }
            
            // Insert images into poll_option_images table
            for (const imageData of optionImages) {
                await client.query(
                    `INSERT INTO poll_option_images (option_id, image_url, is_primary, display_order) 
             VALUES ($1, $2, $3, $4)`,
                    [createdOption.id, imageData.imageUrl, imageData.isPrimary, imageData.displayOrder]
                );
            }
            
            // Get the primary image URL for backward compatibility
            const primaryImageResult = await client.query(
                `SELECT image_url FROM poll_option_images 
         WHERE option_id = $1 AND is_primary = true 
         ORDER BY display_order LIMIT 1`,
                [createdOption.id]
            );
            
            const primaryImageUrl = primaryImageResult.rows.length > 0 ? primaryImageResult.rows[0].image_url : null;
            
            createdOptions.push({
                ...createdOption,
                imageUrl: primaryImageUrl
            });
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
        const activeFilter = req.query.active;
        
        // Build where clause
        let whereClause = 'WHERE p.is_active = true';
        const queryParams = [];
        let paramCount = 1;
        
        // Handle active filter
        if (activeFilter === 'true') {
            // Only active polls that haven't ended
            whereClause += ' AND (p.end_date IS NULL OR p.end_date > CURRENT_TIMESTAMP)';
        } else if (activeFilter === 'false') {
            // Only polls that have ended
            whereClause += ' AND p.end_date IS NOT NULL AND p.end_date <= CURRENT_TIMESTAMP';
        }
        // If activeFilter is undefined or 'all', show all active polls (no additional filter)

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
        p.id, p.title, p.description, p.start_date, p.end_date, p.is_active, p.image_url, p.created_at,
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
        SELECT 
          po.id, po.text, po.description,
          COUNT(vr.id) as actual_vote_count
        FROM poll_options po
        LEFT JOIN vote_records vr ON po.id = vr.option_id
        WHERE po.poll_id = $1
        GROUP BY po.id, po.text, po.description
        ORDER BY po.created_at
      `, [poll.id]);

            // Get primary image for each option
            const optionsWithImages = [];
            for (const option of optionsResult.rows) {
                const primaryImageResult = await pool.query(`
          SELECT image_url FROM poll_option_images 
          WHERE option_id = $1 AND is_primary = true 
          ORDER BY display_order LIMIT 1
        `, [option.id]);
                
                const primaryImageUrl = primaryImageResult.rows.length > 0 ? primaryImageResult.rows[0].image_url : null;
                
                optionsWithImages.push({
                    ...option,
                    imageUrl: primaryImageUrl,
                    voteCount: parseInt(option.actual_vote_count)
                });
            }

            polls.push({
                ...poll,
                totalVotes: parseInt(poll.total_votes),
                options: optionsWithImages
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
        p.id, p.title, p.description, p.start_date, p.end_date, p.is_active, p.image_url, p.created_at,
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
        po.id, po.text, po.description, po.vote_count,
        COUNT(vr.id) as actual_vote_count
      FROM poll_options po
      LEFT JOIN vote_records vr ON po.id = vr.option_id
      WHERE po.poll_id = $1
      GROUP BY po.id, po.text, po.description, po.vote_count
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
        let userHasVotedToday = false;
        if (req.user) {
            // Try Redis first, fallback to database
            userHasVotedToday = await hasVotedToday(req.user.userId, pollId);
            
            // Double-check with database if Redis check fails
            if (!userHasVotedToday) {
                const todayVoteResult = await pool.query(`
          SELECT id FROM vote_records
          WHERE user_id = $1 AND poll_id = $2 AND DATE(voted_at) = CURRENT_DATE
        `, [req.user.userId, pollId]);

                userHasVotedToday = todayVoteResult.rows.length > 0;
            }
        }

        // Get images for each option
        const optionsWithImages = [];
        for (const option of optionsResult.rows) {
            const imagesResult = await pool.query(`
        SELECT image_url, is_primary, display_order
        FROM poll_option_images
        WHERE option_id = $1
        ORDER BY display_order
      `, [option.id]);

            const images = imagesResult.rows.map(img => ({
                url: img.image_url,
                isPrimary: img.is_primary,
                displayOrder: img.display_order
            }));

            optionsWithImages.push({
                id: option.id,
                text: option.text,
                description: option.description,
                images: images,
                imageUrl: images.length > 0 ? images.find(img => img.isPrimary)?.url || images[0].url : null,
                voteCount: parseInt(option.actual_vote_count),
                percentage: totalVotes > 0 ? Math.round((option.actual_vote_count / totalVotes) * 100) : 0
            });
        }

        const result = {
            poll: {
                ...poll,
                totalVotes,
                hasVotedToday: userHasVotedToday,
                canEdit: req.user?.userId === poll.creator_id,
                options: optionsWithImages
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
        p.id, p.title, p.description, p.start_date, p.end_date, p.is_active, p.image_url, p.created_at,
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
        SELECT 
          po.id, po.text, po.description,
          COUNT(vr.id) as actual_vote_count
        FROM poll_options po
        LEFT JOIN vote_records vr ON po.id = vr.option_id
        WHERE po.poll_id = $1
        GROUP BY po.id, po.text, po.description
        ORDER BY po.created_at
      `, [poll.id]);

            // Get primary image for each option
            const optionsWithImages = [];
            for (const option of optionsResult.rows) {
                const primaryImageResult = await pool.query(`
          SELECT image_url FROM poll_option_images 
          WHERE option_id = $1 AND is_primary = true 
          ORDER BY display_order LIMIT 1
        `, [option.id]);
                
                const primaryImageUrl = primaryImageResult.rows.length > 0 ? primaryImageResult.rows[0].image_url : null;
                
                optionsWithImages.push({
                    ...option,
                    imageUrl: primaryImageUrl,
                    voteCount: parseInt(option.actual_vote_count)
                });
            }

            polls.push({
                ...poll,
                totalVotes: parseInt(poll.total_votes),
                options: optionsWithImages
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