import express from 'express';
import mongoose from 'mongoose';

const app = express();

const userSchema = new mongoose.Schema({
  email: String,
  name: String
});

const User = mongoose.model('User', userSchema);

async function getUser(req: express.Request, res: express.Response) {
  const user = await User.findById(req.params.id);
  res.json(user);
}

async function createUser(req: express.Request, res: express.Response) {
  const user = await User.create(req.body);
  res.status(201).json(user);
}

app.get('/users/:id', getUser);
app.post('/users', createUser);
app.listen(3000);
