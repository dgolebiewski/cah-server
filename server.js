const {
  GAME_STATUS_CZAR_PICKING,
  GAME_STATUS_FINISHED,
  GAME_STATUS_PLAYING,
  GAME_STATUS_POST_ROUND,
  GAME_STATUS_WAITING,
} = require('./gameStatus');

const {
  ACTION_CREATE_GAME,
  ACTION_ESTABLISH_CONNECTION,
  ACTION_JOIN_GAME,
  ACTION_GAME_STATE_UPDATE,
  ACTION_UPDATE_CLIENT,
  ACTION_GAMES_LIST_UPDATE,
  ACTION_UPDATE_GAME_SETTINGS,
  ACTION_START_GAME,
  ACTION_PLAY_CARD,
  ACTION_PICK_CARD,
} = require('./actions');
const db = require('./db');

const WebSocket = require('ws');
const uuidv4 = require('uuid').v4;
const { shuffle } = require('./helpers');

const createOkStatusResponse = (data, requestId = null, action = null) => {
  return JSON.stringify({ status: 'Ok', requestId, action, data });
};

const createErrorStatusResponse = (error, requestId = null, action = null) => {
  return JSON.stringify({ status: 'Error', requestId, action, error });
};

const getPublicSettings = settings => {
  const { name, maxScore, whiteCards } = settings;

  return { name, maxScore, whiteCards };
};

const getPublicGameData = (game, client) => {
  const {
    id,
    host,
    black,
    table,
    status,
    lastRoundWinner,
    settings,
    clients,
  } = game;

  return {
    id,
    host,
    black,
    table: table.map(t => ({
      id: t.id,
      white:
        game.status !== GAME_STATUS_PLAYING
          ? t.white
          : t.white.map(c => ({ text: '?' })),
    })),
    status,
    lastRoundWinner,
    settings: getPublicSettings(settings),
    clients: clients.map(c => ({
      id: c.id,
      name: c.name,
      score: c.score,
      host: c.host,
      cardCzar: c.cardCzar,
      played: c.played,
      winner:
        lastRoundWinner &&
        !!table.find(t => t.id === lastRoundWinner && t.clientId === c.id),
    })),
    client: clients.find(c => c.id === client.id),
  };
};

const createClientGameData = (client, host = false) => {
  const { id, name } = client;

  return {
    id,
    name,
    host,
    score: 0,
    cardCzar: false,
    played: false,
    hand: [],
  };
};

const dealCards = (client, white, gameSettings) => {
  client.played = false;

  if (client.hand.length >= gameSettings.whiteCards) {
    return client;
  }

  for (let i = client.hand.length; i < gameSettings.whiteCards; i++) {
    if (white.length === 0) {
      return client;
    }

    const index = Math.floor(Math.random() * white.length);
    client.hand.push(white[index]);
    white.splice(index, 1);
  }

  return client;
};

const nextCzar = game => {
  let czarIndex = game.clients.findIndex(c => c.cardCzar);
  if (czarIndex > -1) {
    game.clients[czarIndex].cardCzar = false;
  }
  czarIndex++;
  if (czarIndex >= game.clients.length) {
    czarIndex = 0;
  }
  game.clients[czarIndex].cardCzar = true;
};

const nextTurn = game => {
  game.clients.forEach(client => {
    dealCards(client, game.whiteDeck, game.settings);
  });

  if (
    game.blackDeck.length === 0 ||
    (game.whiteDeck.length === 0 && game.clients.filter(c => c.white === 0))
  ) {
    game.status = GAME_STATUS_FINISHED;
    return game;
  }

  game.table = [];
  game.lastRoundWinner = null;

  nextCzar(game);

  const blackIndex = Math.floor(Math.random() * game.blackDeck.length);
  game.black = game.blackDeck[blackIndex];
  game.blackDeck.splice(blackIndex, 1);

  game.status = GAME_STATUS_PLAYING;

  return game;
};

let server = null;
let clients = [];
let games = [];

const broadcastGamesList = () => {
  clients.forEach(c => {
    sendGamesList(c);
  });
};

const sendGamesList = client => {
  const list = games.map(game => ({
    id: game.id,
    status: game.status,
    settings: game.settings,
    clients: game.clients,
  }));

  client.ws.send(createOkStatusResponse(list, null, ACTION_GAMES_LIST_UPDATE));
};

const broadcastGameState = game => {
  game.clients.forEach(client => {
    const target = clients.find(c => c.id === client.id);
    if (!target) {
      return;
    }

    const response = createOkStatusResponse(
      getPublicGameData(game, target),
      null,
      ACTION_GAME_STATE_UPDATE,
    );

    target.ws.send(response);
  });
};

const leaveGame = client => {
  const game = games.find(g => g.id === client.gameId);

  if (!game) {
    return;
  }

  if (game.host === client.id) {
    if (game.clients.length === 1) {
      const index = games.findIndex(g => g.id === game.id);
      games.splice(index, 1);

      broadcastGamesList();
      return;
    }

    const clientIndex = game.clients.findIndex(c => c.id === client.id);

    if (game.clients[clientIndex].cardCzar) {
      nextCzar(game);
    }

    game.clients.splice(clientIndex, 1);
    game.clients[0].host = true;
    game.host = game.clients[0].id;

    if (game.clients.length < 3 && game.status !== GAME_STATUS_WAITING) {
      game.status = GAME_STATUS_FINISHED;
    }

    broadcastGameState(game);
    return;
  }

  const clientIndex = game.clients.findIndex(c => c.id === client.id);

  if (game.clients[clientIndex].cardCzar) {
    nextCzar(game);
  }

  game.clients.splice(clientIndex, 1);

  if (game.clients.length < 3 && game.status !== GAME_STATUS_WAITING) {
    game.status = GAME_STATUS_FINISHED;
  }

  broadcastGameState(game);
  return;
};

module.exports = {
  start(port = 8080) {
    if (server) {
      return server;
    }

    server = new WebSocket.Server({ port });

    server.on('connection', ws => {
      ws.on('message', async message => {
        let msgObject = null;
        try {
          msgObject = JSON.parse(message);
        } catch (err) {
          ws.send(createErrorStatusResponse(err));
          return;
        }

        let postResponse = null;

        try {
          let response = null;
          const client = clients.find(c => c.id === msgObject.clientId);
          const game = games.find(g => g.id === msgObject.gameId);
          const player = game?.clients.find(c => c.id === client.id);

          if (!client && msgObject.action !== ACTION_ESTABLISH_CONNECTION) {
            console.log(msgObject);
            throw `Cannot execute action ${msgObject.action}: unknown client`;
          }

          switch (msgObject.action) {
            //TODO: Handle multiple connections from the same client(e.g. multiple cards open in the same browser)
            case ACTION_ESTABLISH_CONNECTION:
              let newClient = client || {
                id: uuidv4(),
                name: msgObject.name || '',
                ws,
              };

              if (client) {
                console.log('client reconnected');
                if (client.timeout) {
                  clearTimeout(client.timeout);
                }
                client.ws = ws;
                newClient = { ...client, ws };
              } else {
                clients.push(newClient);
              }

              ws.on('close', () => {
                newClient.timeout = setTimeout(() => {
                  const currentClient = clients.find(
                    c => c.id === newClient.id,
                  );
                  leaveGame(currentClient);

                  const currentClientIndex = clients.findIndex(
                    c => c.id === newClient.id,
                  );
                  clients.splice(currentClientIndex, 1);
                }, 30000);
              });

              response = { client: newClient };
              postResponse = () => sendGamesList(newClient);
              break;
            case ACTION_UPDATE_CLIENT:
              /*
              Request structure:
                {
                  clientId,
                  name
                }
              */

              client.name = msgObject.name;

              if (client.gameId) {
                const clientGame = games.find(g => g.id === client.gameId);
                if (clientGame) {
                  const targetClient = clientGame.clients.find(
                    c => c.id === client.id,
                  );
                  targetClient.name = client.name;

                  postResponse = () => broadcastGameState(clientGame);
                }
              }

              response = { client };
              break;
            case ACTION_CREATE_GAME:
              /*
              Request structure:
                {
                  clientId,
                  settings: {
                    name?,
                    maxScore?,
                    decks
                  }
                }
              */
              if (!client) {
                throw 'Cannot create a game: unknown client.';
              }

              if (client.gameId) {
                leaveGame(client);
              }

              const newGame = {
                id: uuidv4(),
                host: client.id,
                status: GAME_STATUS_WAITING,
                lastRoundWinner: null,
                settings: {
                  name: '',
                  maxScore: 8,
                  whiteCards: 10,
                  ...msgObject.settings,
                },
                black: null,
                table: [],
                blackDeck: [],
                whiteDeck: [],
                clients: [createClientGameData(client, true)],
              };

              games.push(newGame);

              client.gameId = newGame.id;

              response = { game: getPublicGameData(newGame, client) };
              postResponse = () => broadcastGamesList();
              break;
            case ACTION_UPDATE_GAME_SETTINGS:
              /*
              Request structure:
                {
                  clientId,
                  gameId,
                  settings: {
                    name?,
                    maxScore?,
                    decks?
                  }
                }
              */
              if (!game) {
                throw 'Cannot update game settings: unknown game.';
              }
              if (game.status !== GAME_STATUS_WAITING) {
                throw 'Cannot update game settings: game already started.';
              }
              if (client.id !== game.host) {
                throw 'Cannot update game settings: client is not the host.';
              }

              game.settings = {
                ...game.settings,
                ...msgObject.settings,
              };

              response = { game: getPublicGameData(game) };
              postResponse = () => broadcastGameState(game);
              break;
            case ACTION_JOIN_GAME:
              /*
              Request structure:
                {
                  clientId,
                  gameId,
                }
              */
              if (!game) {
                throw 'Cannot join the game: game not found.';
              }

              if (client.gameId !== game.id) {
                leaveGame(client);
              }

              if (!game.clients.find(c => c.id === client.id)) {
                game.clients.push(createClientGameData(client));
              }

              client.gameId = game.id;

              response = { game: getPublicGameData(game, client) };
              postResponse = () => {
                broadcastGameState(game);
                broadcastGamesList();
              };
              break;
            case ACTION_START_GAME:
              /*
              Request structure:
                {
                  clientId,
                  gameId,
                }
              */
              if (!game) {
                throw 'Cannot start the game: game not found.';
              }

              if (game.host !== client.id) {
                throw 'Cannot start the game: client is not the host.';
              }

              if (game.clients.length < 3) {
                throw 'Cannot start the game: too few clients.';
              }

              game.clients.forEach(c => {
                c.score = 0;
                c.hand = [];
                c.white = [];
              });

              const decks = await db.getDecksByIds(game.settings.decks);

              game.blackDeck = decks.reduce(
                (black, deck) => black.concat(deck.black),
                [],
              );
              game.whiteDeck = decks.reduce(
                (white, deck) => white.concat(deck.white),
                [],
              );

              nextTurn(game);

              response = { game: getPublicGameData(game, client) };
              postResponse = () => {
                broadcastGameState(game);
                broadcastGamesList();
              };
              break;
            case ACTION_PLAY_CARD:
              /*
                Request structure:
                {
                  clientId,
                  gameId,
                  whiteId[]
                }
              */
              if (!game) {
                throw 'Cannot play card(s): game not found.';
              }

              if (game.status !== GAME_STATUS_PLAYING) {
                throw 'Cannot play card(s): incorrect game state.';
              }

              if (!player) {
                throw 'Cannot play card(s): player is not in this game.';
              }

              if (player.cardCzar) {
                throw 'Cannot play card(s): player is the card czar.';
              }

              if (player.played) {
                throw 'Cannot play card(s): player already played this round.';
              }

              //Loop through cards twice to throw an error before making any changes to the game data.
              msgObject.whiteId.forEach(w => {
                if (!player.hand.find(c => '' + c._id === '' + w)) {
                  throw 'Cannot play card(s): player does not own the card.';
                }
              });

              const play = {
                id: uuidv4(),
                clientId: client.id,
                white: [],
              };

              msgObject.whiteId.forEach(w => {
                //Find the card in player's hand
                const cardIndex = player.hand.findIndex(
                  c => '' + c._id === '' + w,
                );

                //Get it's reference
                const card = player.hand[cardIndex];

                //Push it onto the stack of cards in current play
                play.white.push(card);

                //Remove the card from player's hand
                player.hand.splice(cardIndex, 1);

                player.played = true;
              });

              game.table.push(play);

              game.table = shuffle(game.table);

              if (
                !game.clients.find(
                  c => !c.played && !c.cardCzar && !!c.hand.length,
                )
              ) {
                game.status = GAME_STATUS_CZAR_PICKING;
              }

              response = { player };
              postResponse = () => broadcastGameState(game);
              break;
            case ACTION_PICK_CARD:
              /**
               Request structure:
                {
                  clientId,
                  gameId,
                  winnerId
                }
               */

              if (!game) {
                throw 'Cannot pick card: game not found';
              }

              if (game.status !== GAME_STATUS_CZAR_PICKING) {
                throw 'Cannot pick card: incorrect game state.';
              }

              if (!player.cardCzar) {
                throw 'Cannot pick card: player is not the card czar';
              }

              const pick = game.table.find(t => t.id === msgObject.winnerId);

              if (!pick) {
                throw 'Cannot pick card: these cards are not on the table.';
              }

              const winner = game.clients.find(c => c.id === pick.clientId);

              if (!winner) {
                throw 'Cannot pick card: winner is not in the game.';
              }

              winner.score++;
              game.lastRoundWinner = pick.id;
              if (winner.score >= game.settings.maxScore) {
                game.status = GAME_STATUS_FINISHED;
              } else {
                game.status = GAME_STATUS_POST_ROUND;
                setTimeout(() => {
                  nextTurn(game);
                  broadcastGameState(game);
                }, 5000);
              }

              response = { game };
              postResponse = () => broadcastGameState(game);
              break;
            default:
              throw 'Unknown action!';
          }

          if (response) {
            ws.send(
              createOkStatusResponse(response, msgObject.id, msgObject.action),
            );
          }

          if (postResponse) {
            postResponse();
          }
        } catch (err) {
          console.error(err);
          ws.send(
            createErrorStatusResponse(
              JSON.stringify(err),
              msgObject.id,
              msgObject.action,
            ),
          );
        }
      });
    });

    return this.server;
  },
  getGameState(id) {
    const game = games.find(g => g.id === id);

    if (!game) {
      return null;
    }

    return getPublicGameData(game);
  },
};
