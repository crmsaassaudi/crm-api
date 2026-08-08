import { buildMergeValues, personalise } from './personalise';

describe('personalise', () => {
  const values = buildMergeValues({
    firstName: 'Sara',
    lastName: 'Ahmed',
    companyName: 'Northwind',
  });

  it('should substitute whitelisted tokens', () => {
    expect(personalise('Hi {{firstName}} {{lastName}}', values)).toBe(
      'Hi Sara Ahmed',
    );
  });

  it('should derive fullName from the parts', () => {
    expect(personalise('{{fullName}}', values)).toBe('Sara Ahmed');
  });

  it('should tolerate whitespace inside the braces', () => {
    expect(personalise('Hi {{ firstName }}', values)).toBe('Hi Sara');
  });

  /**
   * The whole security model. An unknown token must NOT reach into the contact
   * document â€” leaving it verbatim makes a typo visible in a test send instead
   * of turning into a field the author was not allowed to read.
   */
  it('should leave an unknown token exactly as written', () => {
    expect(personalise('{{emails}} {{__proto__}} {{score}}', values)).toBe(
      '{{emails}} {{__proto__}} {{score}}',
    );
  });

  it('should use the fallback when a value is missing', () => {
    const empty = buildMergeValues({});
    expect(personalise('Hi {{firstName|there}},', empty)).toBe('Hi there,');
  });

  it('should prefer the real value over the fallback', () => {
    expect(personalise('Hi {{firstName|there}},', values)).toBe('Hi Sara,');
  });

  it('should render an empty string when a value is missing and no fallback is given', () => {
    const empty = buildMergeValues({});
    expect(personalise('Hi {{firstName}},', empty)).toBe('Hi ,');
  });

  it('should trim stored values so padded data does not leak spacing', () => {
    const padded = buildMergeValues({ firstName: '  Sara  ', lastName: '' });
    expect(personalise('[{{firstName}}][{{fullName}}]', padded)).toBe(
      '[Sara][Sara]',
    );
  });
});
