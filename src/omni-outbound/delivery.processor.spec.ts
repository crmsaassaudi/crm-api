import { DeliveryProcessor } from './delivery.processor';

describe('DeliveryProcessor', () => {
  let command: any;
  let commands: any;
  let conversations: any;
  let messages: any;
  let channels: any;
  let attempts: any;
  let events: any;
  let adapter: any;
  let emailHandler: any;
  let mediaHandler: any;
  let processor: DeliveryProcessor;

  beforeEach(() => {
    command = {
      _id: 'command_1',
      tenantId: 'tenant_1',
      messageId: 'message_1',
      conversationId: 'conversation_1',
      agentId: 'agent_1',
      content: 'hello',
      messageType: 'text',
      source: 'agent_ui',
      transport: 'socket',
      status: 'processing',
    };
    commands = {
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(command),
      }),
      updateOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      }),
    };
    conversations = {
      findById: jest.fn().mockResolvedValue({
        id: 'conversation_1',
        channelId: 'channel_1',
        channelType: 'facebook',
        channelAccount: 'page_1',
        customer: { externalId: 'customer_1' },
      }),
    };
    messages = { updateStatus: jest.fn().mockResolvedValue(undefined) };
    channels = {
      findByIdWithCredentials: jest.fn().mockResolvedValue({
        credentials: { accessToken: 'secret' },
        account: 'page_1',
      }),
      findByAccountWithCredentials: jest.fn(),
    };
    attempts = {
      start: jest.fn().mockResolvedValue('attempt_1'),
      succeed: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue('unknown'),
    };
    events = { emit: jest.fn() };
    adapter = {
      send: jest.fn().mockResolvedValue({ message_id: 'provider_1' }),
    };
    emailHandler = {
      dispatchDeliveryCommand: jest.fn().mockResolvedValue({
        message_id: 'email_provider_1',
        emailProjection: { messageId: 'message_1' },
      }),
      projectSuccessfulDelivery: jest.fn().mockResolvedValue(undefined),
    };
    mediaHandler = {
      dispatchDeliveryCommand: jest
        .fn()
        .mockResolvedValue({ message_id: 'media_provider_1' }),
    };
    processor = new DeliveryProcessor(
      {} as any,
      commands,
      conversations,
      messages,
      channels,
      attempts,
      events,
      new Map([['facebook', adapter]]) as any,
      { incrementCounter: jest.fn() } as any,
      emailHandler,
      mediaHandler,
    );
  });

  const job = {
    data: { tenantId: 'tenant_1', commandId: 'command_1' },
  } as any;

  it('should delivers a claimed command and completes all projections', async () => {
    await (processor as any).handle(job);

    expect(adapter.send).toHaveBeenCalledWith(
      'customer_1',
      'hello',
      'text',
      expect.objectContaining({
        credentials: { accessToken: 'secret' },
        messageId: 'message_1',
      }),
    );
    expect(attempts.succeed).toHaveBeenCalledWith('attempt_1', 'provider_1');
    expect(messages.updateStatus).toHaveBeenCalledWith(
      'message_1',
      'sent',
      'provider_1',
    );
    expect(commands.updateOne).toHaveBeenCalledWith(
      { _id: 'command_1', status: 'processing' },
      { $set: expect.objectContaining({ status: 'completed' }) },
    );
    expect(events.emit).toHaveBeenCalledWith(
      'omni.message.sent',
      expect.objectContaining({
        messageId: 'message_1',
        externalMessageId: 'provider_1',
      }),
    );
  });

  it('should records an ambiguous provider timeout without automatic redelivery', async () => {
    adapter.send.mockRejectedValue(
      Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    );

    await (processor as any).handle(job);

    expect(attempts.fail).toHaveBeenCalledWith(
      'attempt_1',
      expect.objectContaining({ code: 'ETIMEDOUT' }),
    );
    expect(messages.updateStatus).toHaveBeenCalledWith('message_1', 'failed');
    expect(commands.updateOne).toHaveBeenCalledWith(
      { _id: 'command_1', status: 'processing' },
      { $set: expect.objectContaining({ status: 'unknown' }) },
    );
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it('should dispatches a template through the adapter capability', async () => {
    command.kind = 'template';
    command.messageType = 'template';
    command.payload = {
      templateName: 'order_update',
      languageCode: 'en',
      components: [{ type: 'body' }],
    };
    adapter.sendTemplate = jest
      .fn()
      .mockResolvedValue({ message_id: 'provider_template_1' });

    await (processor as any).handle(job);

    expect(adapter.sendTemplate).toHaveBeenCalledWith(
      'customer_1',
      'order_update',
      'en',
      [{ type: 'body' }],
      expect.objectContaining({ messageId: 'message_1' }),
    );
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('should dispatches email commands through the email handler without a channel adapter', async () => {
    command.kind = 'email';
    command.messageType = 'email';
    command.payload = {
      to: ['customer@example.test'],
      subject: 'Hello',
      htmlBody: '<p>Hello</p>',
    };
    conversations.findById.mockResolvedValue({
      id: 'conversation_1',
      channelId: 'channel_1',
      channelType: 'email',
      channelAccount: 'mailbox_1',
      customer: {},
    });

    await (processor as any).handle(job);

    expect(emailHandler.dispatchDeliveryCommand).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      conversationId: 'conversation_1',
      agentId: 'agent_1',
      messageId: 'message_1',
      payload: command.payload,
    });
    expect(emailHandler.projectSuccessfulDelivery).toHaveBeenCalledWith({
      messageId: 'message_1',
    });
    expect(adapter.send).not.toHaveBeenCalled();
    expect(messages.updateStatus).toHaveBeenCalledWith(
      'message_1',
      'sent',
      'email_provider_1',
    );
  });

  it('should dispatches media commands through the media handler', async () => {
    command.kind = 'media';
    command.messageType = 'image';
    command.payload = {
      media: { fileId: 'file_1', mimeType: 'image/jpeg', fileName: 'a.jpg' },
      caption: 'photo',
    };

    await (processor as any).handle(job);

    expect(mediaHandler.dispatchDeliveryCommand).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      conversationId: 'conversation_1',
      agentId: 'agent_1',
      messageId: 'message_1',
      payload: command.payload,
    });
    expect(adapter.send).not.toHaveBeenCalled();
    expect(messages.updateStatus).toHaveBeenCalledWith(
      'message_1',
      'sent',
      'media_provider_1',
    );
  });

  it('should uses a deterministic text fallback for unsupported interactive content', async () => {
    command.kind = 'interactive';
    command.messageType = 'interactive';
    command.payload = {
      body: 'Choose',
      buttons: [{ title: 'One' }, { title: 'Two' }],
    };

    await (processor as any).handle(job);

    expect(adapter.send).toHaveBeenCalledWith(
      'customer_1',
      'Choose\n\n1. One\n2. Two',
      'text',
      expect.anything(),
    );
  });

  it('should does not turn a provider success into a failed delivery when a projection is unavailable', async () => {
    messages.updateStatus.mockRejectedValue(new Error('mongo unavailable'));

    await expect((processor as any).handle(job)).resolves.toBeUndefined();

    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(commands.updateOne).toHaveBeenCalledWith(
      { _id: 'command_1', status: 'processing' },
      { $set: expect.objectContaining({ status: 'completed' }) },
    );
    expect(attempts.fail).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      'omni.message.sent',
      expect.objectContaining({ status: 'sent' }),
    );
  });
});
