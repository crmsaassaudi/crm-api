import { BadRequestException } from '@nestjs/common';
import { CHANNEL_DELIVERY, assertChannelConfig } from './campaign-channel';

describe('assertChannelConfig', () => {
  it('should accept a complete email config', () => {
    expect(() =>
      assertChannelConfig({
        type: 'email',
        configId: 'c1',
        subject: 'Hello',
        htmlBody: '<p>Hi</p>',
      }),
    ).not.toThrow();
  });

  it.each([
    ['no subject', { type: 'email', configId: 'c1', htmlBody: '<p>Hi</p>' }],
    [
      'blank subject',
      { type: 'email', configId: 'c1', subject: '   ', htmlBody: 'x' },
    ],
    ['no body', { type: 'email', configId: 'c1', subject: 'Hello' }],
    ['no sender', { type: 'email', subject: 'Hello', htmlBody: 'x' }],
  ])('should reject an email config with %s', (_label, config) => {
    expect(() => assertChannelConfig(config)).toThrow(BadRequestException);
  });

  it('should accept a complete SMS config', () => {
    expect(() =>
      assertChannelConfig({ type: 'sms', configId: 'c1', message: 'Hi' }),
    ).not.toThrow();
  });

  it('should reject an SMS body above the provider limit', () => {
    expect(() =>
      assertChannelConfig({
        type: 'sms',
        configId: 'c1',
        message: 'x'.repeat(1601),
      }),
    ).toThrow(BadRequestException);
  });

  it('should accept a complete WhatsApp config', () => {
    expect(() =>
      assertChannelConfig({
        type: 'whatsapp',
        channelId: 'ch1',
        templateName: 'eid_promo',
        languageCode: 'en_US',
        bodyParams: ['{{firstName}}'],
      }),
    ).not.toThrow();
  });

  it('should reject WhatsApp template parameters that are not strings', () => {
    expect(() =>
      assertChannelConfig({
        type: 'whatsapp',
        channelId: 'ch1',
        templateName: 'eid_promo',
        languageCode: 'en_US',
        bodyParams: [{ nested: true }],
      }),
    ).toThrow(BadRequestException);
  });

  /**
   * Facebook and Instagram must stay unsupported: Messenger's 24-hour window has
   * no broadcast exception, so a campaign on it would fail for most of its
   * audience and put the Page at risk.
   */
  it.each(['facebook', 'instagram', 'zalo', 'livechat', undefined])(
    'should refuse the unsupported channel %p',
    (type) => {
      expect(() => assertChannelConfig({ type, configId: 'c1' })).toThrow(
        BadRequestException,
      );
    },
  );

  it.each([null, undefined, 'string', 42])(
    'should refuse %p as a config',
    (config) => {
      expect(() => assertChannelConfig(config)).toThrow(BadRequestException);
    },
  );
});

describe('CHANNEL_DELIVERY', () => {
  /**
   * Every channel carries its own consent flag, email included. Email had none
   * for as long as consent was a two-state boolean — `false` could not be told
   * apart from "never asked" — and the consequence was that unsubscribing did
   * not stop the next campaign.
   */
  it('should give every channel a consent field of its own', () => {
    expect(CHANNEL_DELIVERY.email.consentField).toBe('emailOptIn');
    expect(CHANNEL_DELIVERY.sms.consentField).toBe('smsOptIn');
    expect(CHANNEL_DELIVERY.whatsapp.consentField).toBe('whatsappOptIn');
  });

  /** A blanket refusal of outbound contact, which email is not subject to. */
  it('should apply doNotCall to the phone channels only', () => {
    expect(CHANNEL_DELIVERY.email.restrictionField).toBeUndefined();
    expect(CHANNEL_DELIVERY.sms.restrictionField).toBe('doNotCall');
    expect(CHANNEL_DELIVERY.whatsapp.restrictionField).toBe('doNotCall');
  });
});
