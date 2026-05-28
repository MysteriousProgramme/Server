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

// DELETE /api/v1/sessions/:id
// Requires a valid staff name in the headers
router.delete('/sessions/:id', async (req, res) => {
    const { id } = req.params;
    const staffName = req.headers['staff-name'];

    if (!staffName) {
        return res.status(400).json({ error: "Missing staff-name header" });
    }

    try {
        // 1. Verify the user requesting the deletion is actually Staff
        const staffRes = await pool.query('SELECT * FROM staff_players WHERE LOWER(player_name) = LOWER($1)', [staffName]);
        
        if (staffRes.rowCount === 0) {
            return res.status(403).json({ error: "Unauthorized: Only staff members can delete API sessions." });
        }

        // 2. Delete the session from the database
        const deleteRes = await pool.query('DELETE FROM sessions_cache WHERE session_id = $1', [id]);

        if (deleteRes.rowCount > 0) {
            console.log(`[Public API] Session ${id} deleted by staff member ${staffName}`);
            res.json({ success: true, message: `Session ${id} successfully deleted.` });
        } else {
            res.status(404).json({ error: "Session not found." });
        }

    } catch (err) {
        console.error(`[Public API] Error deleting session ${id}:`, err);
        res.status(500).json({ error: "Database error deleting session" });
    }
});

module.exports = router;