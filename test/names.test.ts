// Nobody chooses a name: a player is what the hub calls their screen's seat, and the tags over the
// cars and the kill feed use its short form. The hub counts in words, so the short form reads them back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localName, playerName, playerTag } from '../src/net/protocol.ts';

test("a screen's first player has the seat's name, the others a letter after it", () => {
  assert.equal(playerName('Player Three', 0), 'Player Three');
  assert.equal(playerName('Player Three', 1), 'Player Three B');
  assert.equal(playerName('Bot One', 0), 'Bot One');
});

test("the short form reads the hub's count back", () => {
  const cases: [string, string][] = [
    ['Player One', 'P1'],
    ['Bot Two', 'B2'],
    ['Player Nineteen', 'P19'],
    ['Player Twenty', 'P20'],
    ['Bot Twenty-One', 'B21'],
    ['Player One Hundred', 'P100'],
    ['Player One Hundred Five', 'P105'],
    ['Player Nine Hundred Ninety-Nine', 'P999'],
    ['Player 1000', 'P1000'],
  ];
  for (const [name, tag] of cases) assert.equal(playerTag(name, 0), tag, name);
  assert.equal(playerTag('Player Three', 1), 'P3b');
});

test("a name the hub didn't count stays whole", () => {
  for (const name of ['Spectator', 'Server', 'Player', 'Player  Hundred', 'Player Zero', 'Player Lots'])
    assert.equal(playerTag(name, 0), name);
});

test('offline, the players on a screen are counted in the order they sit', () => {
  assert.deepEqual([0, 1, 2, 3].map(localName), ['Player One', 'Player Two', 'Player Three', 'Player Four']);
  assert.equal(playerTag(localName(1), 0), 'P2');
});
