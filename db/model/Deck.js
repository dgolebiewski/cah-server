const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');
const { Schema } = mongoose;

const deckSchema = new Schema({
  name: {
    type: String,
    required: true,
  },
  slug: {
    type: String,
    required: true,
  },
  black: [
    {
      text: {
        type: String,
        required: true,
      },
      pick: {
        type: Number,
        default: 1,
      },
    },
  ],
  white: [
    {
      text: {
        type: String,
        required: true,
      },
    },
  ],
});

deckSchema.plugin(mongoosePaginate);

module.exports = mongoose.model('Deck', deckSchema);
