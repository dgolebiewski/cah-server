require('dotenv').config();

const mongoose = require('mongoose');
const Deck = require('./model/Deck');

const escapeStringRegexp = require('escape-string-regexp');

const { DB_HOST, DB_USER, DB_PASS, DB_NAME } = process.env;

let db = null;
let ready = false;
let readyListeners = [];

module.exports = {
  readyListeners: [],
  start() {
    if (db) {
      if (!ready) {
        return new Promise(resolve => {
          readyListeners.push(resolve);
        });
      }

      return new Promise(resolve => resolve(db));
    }

    mongoose.connect(
      `mongodb+srv://${DB_USER}:${DB_PASS}@${DB_HOST}/${DB_NAME}?retryWrites=true&w=majority`,
      { useNewUrlParser: true, useUnifiedTopology: true },
    );

    db = mongoose.connection;

    db.on('error', console.error.bind(console, 'connection error:'));
    db.once('open', async () => {
      console.log('database connected!');
      ready = true;
      readyListeners.forEach(listener => {
        listener(db);
      });
    });

    return new Promise(resolve => {
      readyListeners.push(resolve);
    });
  },
  async getDecks(search = '', page = 1) {
    if (!ready) {
      await this.start();
    }

    const options = { page };

    let decks = null;

    if (!search) {
      decks = await Deck.paginate({}, options);
    } else {
      decks = await Deck.paginate(
        { name: { $regex: new RegExp(escapeStringRegexp(search), 'i') } },
        options,
      );
    }

    return decks;
  },
  async getDeck(slug) {
    if (!ready) {
      await this.start();
    }

    const deck = await Deck.findOne({ slug }).exec();

    return deck;
  },
  async getDecksByIds(ids) {
    if (!ready) {
      await this.start();
    }

    const decks = await Deck.find({
      _id: { $in: ids.map(id => mongoose.Types.ObjectId(id)) },
    });

    return decks;
  },
};
