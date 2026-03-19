require('dotenv').config();
const express = require('express');
const path    = require('path');

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname)));

app.use('/api',         require('./routes/core'));
app.use('/api/fitness', require('./routes/fitness'));
app.use('/api/skill',   require('./routes/skills'));
app.use('/api',         require('./routes/plan'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const { getKey } = require('./lib/openai');
  console.log(`\n🏢  Agent Office → http://localhost:${PORT}`);
  console.log(getKey() ? '✅  API key loaded from .env\n' : '💡  No API key — enter it in the browser\n');
});
