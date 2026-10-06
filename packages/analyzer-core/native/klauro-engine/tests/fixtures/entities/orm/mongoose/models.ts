import { Schema, model, Types } from 'mongoose';

const albumSchema = new Schema({
  title: { type: String },
  tracks: [{ type: Types.ObjectId, ref: 'Track' }],
});

const trackSchema = new Schema({
  name: String,
  album: { type: Types.ObjectId, ref: 'Album' },
});

export const Album = model('Album', albumSchema);
export const Track = model('Track', trackSchema);
