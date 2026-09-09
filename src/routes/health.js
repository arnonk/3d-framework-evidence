const router = require('express').Router();
router.get('/health', (req, res) => res.json({ status: 'up', ts: Date.now() }));
module.exports = router;
