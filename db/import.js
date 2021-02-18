const db = require('./index');
const Deck = require('./model/Deck');

const fs = require('fs');
const slugify = require('slugify');

const rawData = fs.readFileSync('src/data/cah-cards-full.json');
const decks = Object.values(JSON.parse(rawData));

const importAction = async () => {
  await db.start();

  console.log('Import started');
  decks.forEach(deck => {
    const d = new Deck({
      name: deck.name,
      slug: slugify(deck.name, {
        replacement: '-',
        lower: true,
        strict: true,
        locale: 'vi',
      }),
      black: deck.black.map(b => ({ text: b.text, pick: parseInt(b.pick) })),
      white: deck.white.map(w => ({ text: w.text })),
    });

    try {
      d.save();
    } catch (err) {
      console.log(`Unable to save deck: ${deck.name}`);
    }
  });

  console.log('Import complete');
};

importAction();
