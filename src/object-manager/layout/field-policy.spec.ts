import { ObjectRegistryService } from '../object-registry.service';
import {
  DEFAULT_LAYOUT_GROUP,
  StoredLayout,
  applyMask,
  resolveFieldPolicy,
  selectApplicableLayouts,
} from './field-policy';

const registry = new ObjectRegistryService();

const policyFor = (layouts: StoredLayout[], object: any = 'Contact') =>
  resolveFieldPolicy({
    object,
    layouts,
    resolveField: (key) => registry.resolveFieldKey(object, key),
    payloadKeysOf: (field) => registry.payloadKeysOf(field),
  });

describe('selectApplicableLayouts', () => {
  const groupLayouts = {
    [DEFAULT_LAYOUT_GROUP]: { Contact: [{ key: 'ownerId' }] },
    'group-a': { Contact: [{ key: 'emails' }] },
    'group-b': { Contact: [{ key: 'phones' }] },
  };

  it('should return nothing when no layouts are configured', () => {
    expect(selectApplicableLayouts(undefined, ['group-a'])).toEqual([]);
  });

  it('should fall back to the default layout when the caller has no group layout', () => {
    expect(selectApplicableLayouts(groupLayouts, ['group-z'])).toEqual([
      groupLayouts[DEFAULT_LAYOUT_GROUP],
    ]);
  });

  it('should use every matching group layout', () => {
    expect(
      selectApplicableLayouts(groupLayouts, ['group-a', 'group-b']),
    ).toEqual([groupLayouts['group-a'], groupLayouts['group-b']]);
  });

  it('should not add the default layout on top of an explicit one', () => {
    // The default is a fallback, not an extra grant: inheriting it would undo a
    // deliberately narrowed group layout.
    expect(selectApplicableLayouts(groupLayouts, ['group-a'])).not.toContain(
      groupLayouts[DEFAULT_LAYOUT_GROUP],
    );
  });
});

describe('resolveFieldPolicy', () => {
  it('should be empty for an empty layout set', () => {
    const policy = policyFor([]);
    expect(policy.hidden.size).toBe(0);
    expect(policy.readOnly.size).toBe(0);
    expect(policy.masking.size).toBe(0);
    expect(policy.required.size).toBe(0);
  });

  it('should translate a stored column key to the payload key', () => {
    // The whole class of bug: a layout stored `owner`, the response carries
    // `ownerId`, and nothing connected the two.
    const policy = policyFor([
      { Contact: [{ key: 'owner', accessLevel: 'hidden' }] },
    ]);
    expect([...policy.hidden]).toEqual(['ownerId']);
  });

  it('should translate a pre-split legacy alias', () => {
    const policy = policyFor(
      [{ Deal: [{ key: 'amount', masking: 'mask_all' }] }],
      'Deal',
    );
    expect(policy.masking.get('value')).toBe('mask_all');
  });

  it('should cover a server-maintained duplicate of the same value', () => {
    // Deal.name is a copy of Deal.title. Masking one and not the other hands the
    // value back in the property nobody thought to look at.
    const policy = policyFor(
      [{ Deal: [{ key: 'title', masking: 'last_4' }] }],
      'Deal',
    );
    expect(policy.masking.get('title')).toBe('last_4');
    expect(policy.masking.get('name')).toBe('last_4');
  });

  it('should read only the requested object’s entries', () => {
    // `ownerId`, `tags` and `statusId` exist on every object, so cross-reading a
    // layout would be both easy and invisible.
    const policy = policyFor([
      {
        Contact: [{ key: 'emails', accessLevel: 'hidden' }],
        Ticket: [{ key: 'subject', accessLevel: 'hidden' }],
      },
    ]);
    expect([...policy.hidden]).toEqual(['emails']);
  });

  it('should ignore an entry for a field the object does not have', () => {
    const policy = policyFor([{ Contact: [{ key: 'retiredField' }] }]);
    expect(policy.hidden.size).toBe(0);
  });

  describe('merging across a caller’s groups resolves toward less exposure', () => {
    it('should hide a field any group hides', () => {
      const policy = policyFor([
        { Contact: [{ key: 'emails', accessLevel: 'read_write' }] },
        { Contact: [{ key: 'emails', accessLevel: 'hidden' }] },
      ]);
      expect(policy.hidden.has('emails')).toBe(true);
    });

    it('should keep read_only when another group allows writing', () => {
      const policy = policyFor([
        { Contact: [{ key: 'phones', accessLevel: 'read_write' }] },
        { Contact: [{ key: 'phones', accessLevel: 'read_only' }] },
      ]);
      expect(policy.readOnly.has('phones')).toBe(true);
    });

    it('should take the stronger masking', () => {
      const policy = policyFor([
        { Contact: [{ key: 'phones', masking: 'last_4' }] },
        { Contact: [{ key: 'phones', masking: 'mask_all' }] },
      ]);
      expect(policy.masking.get('phones')).toBe('mask_all');
    });

    it('should not weaken masking when a later layout is more permissive', () => {
      const policy = policyFor([
        { Contact: [{ key: 'phones', masking: 'mask_all' }] },
        { Contact: [{ key: 'phones', masking: 'last_4' }] },
      ]);
      expect(policy.masking.get('phones')).toBe('mask_all');
    });
  });

  describe('isRequired', () => {
    it('should record a required writable field under its payload key', () => {
      const policy = policyFor(
        [{ Ticket: [{ key: 'type', isRequired: true }] }],
        'Ticket',
      );
      expect([...policy.required]).toEqual(['typeId']);
    });

    it('should refuse to require a server-owned field', () => {
      // The Ticket `type` bug, generalised: a required check on a field the client
      // cannot set is a 422 with no remedy.
      const policy = policyFor(
        [{ Ticket: [{ key: 'ticketNumber', isRequired: true }] }],
        'Ticket',
      );
      expect(policy.required.size).toBe(0);
    });

    it('should refuse to require an audit field', () => {
      const policy = policyFor([
        { Contact: [{ key: 'createdAt', isRequired: true }] },
      ]);
      expect(policy.required.size).toBe(0);
    });

    it('should refuse to require a field it also hides', () => {
      const policy = policyFor([
        {
          Contact: [{ key: 'emails', isRequired: true, accessLevel: 'hidden' }],
        },
      ]);
      expect(policy.required.size).toBe(0);
      expect(policy.hidden.has('emails')).toBe(true);
    });
  });

  it('should treat isVisible:false as hidden', () => {
    const policy = policyFor([
      { Contact: [{ key: 'title', isVisible: false }] },
    ]);
    expect(policy.hidden.has('title')).toBe(true);
  });

  it('should mark a registry read-only field read-only even with no layout opinion', () => {
    const policy = policyFor([{ Contact: [{ key: 'score' }] }]);
    expect(policy.readOnly.has('score')).toBe(true);
  });
});

describe('applyMask', () => {
  it('should replace the whole value', () => {
    expect(applyMask('secret@example.com', 'mask_all')).toBe('********');
  });

  it('should keep the last four characters', () => {
    expect(applyMask('0987654321', 'last_4')).toBe('****4321');
  });

  it('should fully masks a value too short to partially reveal', () => {
    expect(applyMask('123', 'last_4')).toBe('********');
  });

  it('should be idempotent so a re-serialised response is not double-masked', () => {
    expect(applyMask('****4321', 'mask_all')).toBe('****4321');
  });

  it('should leave the value alone for the none strategy', () => {
    expect(applyMask('keep', 'none')).toBe('keep');
  });
});
