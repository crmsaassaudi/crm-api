import { Injectable } from '@nestjs/common';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { PrincipalGroupsService } from '../principal-groups.service';
import { ConfigurableObject } from '../object-registry';
import { ObjectRegistryService } from '../object-registry.service';
import {
  EMPTY_FIELD_POLICY,
  ResolvedFieldPolicy,
  StoredLayoutSettings,
  resolveFieldPolicy,
  selectApplicableLayouts,
} from './field-policy';

export const LAYOUT_SETTINGS_KEY = 'layout_settings';

/**
 * The one place that turns the stored `layout_settings` document into a decision.
 *
 * Every consumer — the response masker, the write guard, each module's required-
 * field check, and the `/me/object-config` endpoint the browser renders from —
 * goes through `policyFor`. That is the point: those five used to each interpret
 * the document their own way (three of them by reading `groupLayouts['default']`
 * directly), and disagreeing interpretations of a security setting is how a field
 * ends up hidden in the UI and present in the JSON.
 *
 * Per-request memoisation: `CrmSettingsService.getSetting` is already cached, but
 * resolving a policy also walks the caller's layouts, and a paginated response
 * masks up to 100 records through the same policy. Resolving once per
 * (object, request) keeps that off the hot path.
 */
@Injectable()
export class LayoutSettingsService {
  private readonly perRequest = new WeakMap<
    object,
    Map<string, ResolvedFieldPolicy>
  >();

  constructor(
    private readonly settings: CrmSettingsService,
    private readonly registry: ObjectRegistryService,
    private readonly principalGroups: PrincipalGroupsService,
  ) {}

  /** The raw stored document. Admin surfaces only — consumers want `policyFor`. */
  async raw(): Promise<StoredLayoutSettings> {
    const value = await this.settings.getSetting(LAYOUT_SETTINGS_KEY);
    return isStoredLayoutSettings(value) ? value : {};
  }

  /**
   * The effective field policy for the current caller on `object`.
   *
   * @param scope an object identifying the request, used only as a memoisation
   *   key. Pass the Express request where one exists; omit it in workers, where
   *   there is nothing to key on and the settings cache already absorbs the read.
   */
  async policyFor(
    object: ConfigurableObject,
    scope?: object,
  ): Promise<ResolvedFieldPolicy> {
    const cached = scope ? this.perRequest.get(scope)?.get(object) : undefined;
    if (cached) return cached;

    const policy = await this.compute(object);

    if (scope) {
      const forScope = this.perRequest.get(scope) ?? new Map();
      forScope.set(object, policy);
      this.perRequest.set(scope, forScope);
    }

    return policy;
  }

  private async compute(
    object: ConfigurableObject,
  ): Promise<ResolvedFieldPolicy> {
    const [settings, groupIds] = await Promise.all([
      this.raw(),
      this.principalGroups.groupIds(),
    ]);

    const layouts = selectApplicableLayouts(settings.groupLayouts, groupIds);
    if (layouts.length === 0) return EMPTY_FIELD_POLICY;

    return resolveFieldPolicy({
      object,
      layouts,
      resolveField: (key) => this.registry.resolveFieldKey(object, key),
      payloadKeysOf: (field) => this.registry.payloadKeysOf(field),
    });
  }
}

const isStoredLayoutSettings = (
  value: unknown,
): value is StoredLayoutSettings =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
