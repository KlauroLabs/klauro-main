const express = require('express');
const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 5000, () => {
  console.log('shipped listening');
});
