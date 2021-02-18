const shuffle = arr => {
  return arr.sort(() => Math.random() - 0.5);
};

const getRandomFromArray = (arr, n) => {
  let result = new Array(n),
    len = arr.length,
    taken = new Array(len);
  if (n > len)
    throw new RangeError(
      'getRandomFromArray: more elements taken than available',
    );
  while (n--) {
    let x = Math.floor(Math.random() * len);
    result[n] = arr[x in taken ? taken[x] : x];
    taken[x] = --len in taken ? taken[len] : len;
  }
  return result;
};

module.exports = {
  shuffle,
  getRandomFromArray,
};
