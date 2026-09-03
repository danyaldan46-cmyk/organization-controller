require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { authenticate } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const peopleRoutes = require('./routes/people');
const taskRoutes = require('./routes/tasks');
const payrollRoutes = require('./routes/payroll');
const cvRoutes = require('./routes/cv');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

// Public
app.use('/auth', authRoutes);

// Everything below requires a valid JWT; req.user is populated with
// { id, orgId, path, roleTitle, name, email, isHead }
app.use(authenticate);

app.use('/people', peopleRoutes);
app.use('/tasks', taskRoutes);
app.use('/payroll', payrollRoutes);
app.use('/cv', cvRoutes);

// Central error handler (covers thrown errors from express-async-errors)
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Organization Controller API listening on port ${PORT}`);
});
