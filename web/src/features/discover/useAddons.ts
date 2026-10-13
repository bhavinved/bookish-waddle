import { useEffect, useState } from 'react';
import { useLive } from '../../app/hooks';
import { BUILTIN_ADDONS, fetchManifest, type Manifest } from '../../core/addon';
import { db } from '../../core/db';

export interface AddonEntry {
  baseUrl: string;
  builtin: boolean;
  manifest?: Manifest;
  error?: string;
}

/** Built-in add-ons (always present, manifests fetched from our server) followed by the installed ones. */
export function useAddons(): AddonEntry[] {
  const installed = useLive(() => db.addons.toArray(), []);
  const [builtins, setBuiltins] = useState<AddonEntry[]>(() => BUILTIN_ADDONS.map((baseUrl) => ({ baseUrl, builtin: true })));

  useEffect(() => {
    void Promise.all(
      BUILTIN_ADDONS.map(async (baseUrl): Promise<AddonEntry> => {
        try {
          return { baseUrl, builtin: true, manifest: await fetchManifest(baseUrl) };
        } catch {
          return { baseUrl, builtin: true, error: 'Could not reach the server. Is it running?' };
        }
      }),
    ).then(setBuiltins);
  }, []);

  return [...builtins, ...(installed ?? []).map((a) => ({ baseUrl: a.baseUrl, builtin: false, manifest: a.manifest }))];
}
