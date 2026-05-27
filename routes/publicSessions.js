const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

// Initialize a separate pool connection for the public API 
// using the same Render Database URL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } 
});

// GET /api/v1/sessions
// Query params: ?type=war|gank & ?status=active|completed
router.get('/sessions', async (req, res) => {
    const { type, status } = req.query;
    
    try {
        // Base query selecting from your existing sessions_cache table
        let queryText = 'SELECT session_id, session_data, last_updated FROM sessions_cache WHERE 1=1';
        const queryParams = [];
        let paramIndex = 1;

        // Filter by 'type' inside the JSONB session_data column
        if (type) {
            queryText += ` AND session_data->>'type' = $${paramIndex}`;
            queryParams.push(type);
            paramIndex++;
        }

        // Filter by 'status' inside the JSONB session_data column
        if (status) {
            queryText += ` AND session_data->>'status' = $${paramIndex}`;
            queryParams.push(status);
            paramIndex++;
        }

        // Order by most recent updates
        queryText += ' ORDER BY last_updated DESC';

        const result = await pool.query(queryText, queryParams);
        
        res.json({
            success: true,
            count: result.rowCount,
            data: result.rows.map(row => ({
                sessionId: row.session_id,
                sessionData: row.session_data,
                lastUpdated: row.last_updated
            }))
        });

    } catch (err) {
        console.error("[Public API] Error fetching sessions:", err);
        res.status(500).json({ error: "Database error fetching sessions" });
    }
});

module.exports = router;