const express = require('express');
const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 4000, () => {
  console.log('api listening');
});
