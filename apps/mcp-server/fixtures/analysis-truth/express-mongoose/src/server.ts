import express from 'express';
import mongoose from 'mongoose';

const app = express();

const userSchema = new mongoose.Schema({
  email: String,
  name: String
});

const User = mongoose.model('User', userSchema);

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization;
  if (!token || !token.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

async function getUser(req: express.Request, res: express.Response) {
  const user = await User.findById(req.params.id);
  res.json(user);
}

async function createUser(req: express.Request, res: express.Response) {
  const user = await User.create(req.body);
  res.status(201).json(user);
}

app.get('/users/:id', requireAuth, getUser);
app.post('/users', requireAuth, createUser);
app.listen(3000);
