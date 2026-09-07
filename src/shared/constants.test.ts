import { CONFLICT_MODES, SECRET_SENTINEL, SHARE_NAME_PATTERN } from './constants';

describe('shared constants', () => {
  describe('SHARE_NAME_PATTERN', () => {
    it.each(['programs', 'cnc-halle2', 'A_1', 'a'.repeat(32)])('accepts %s', (name) => {
      expect(SHARE_NAME_PATTERN.test(name)).toBe(true);
    });

    it.each([
      '',
      'a'.repeat(33),
      'with space',
      '../escape',
      'semi;colon',
      'dollar$(id)',
      'back`tick`',
      'slash/inside',
      'dot.dot',
    ])('rejects %s', (name) => {
      expect(SHARE_NAME_PATTERN.test(name)).toBe(false);
    });
  });

  it('exposes exactly the three specified conflict modes', () => {
    expect(CONFLICT_MODES).toEqual(['tnc_wins', 'server_wins', 'last_write_wins']);
  });

  it('uses a fixed-width sentinel that cannot be mistaken for a real secret', () => {
    expect(SECRET_SENTINEL).toBe('********');
  });
});
