const express = require('express');
const app = express();

// No Dockerfile, no build/installer artifact, and NOT imported by `shipped` —
// this sibling app must NOT be force-merged into `shipped`'s deployable.
app.get('/status', (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 5001, () => {
  console.log('unshipped listening');
});
