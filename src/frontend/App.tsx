import { API_BASE_PATH, apiContract, buildPath, ENDPOINT_IDS, PRODUCT_NAME } from '../shared';

/**
 * Placeholder shell. The real layout, routing and auth guard land in T32.
 *
 * It deliberately imports the whole shared barrel — constants, every Zod schema and
 * the API contract. That makes the T2 acceptance criterion something the build
 * enforces rather than something we assert: if anything under `src/shared` ever
 * reaches for a Node built-in or a backend module, this bundle stops compiling.
 */
export function App(): JSX.Element {
  return (
    <main>
      <h1>{PRODUCT_NAME}</h1>
      <p>
        API base path: <code>{API_BASE_PATH}</code>
      </p>
      <p>{ENDPOINT_IDS.length} endpoints defined in the shared contract.</p>
      <ul>
        {ENDPOINT_IDS.slice(0, 5).map((id) => (
          <li key={id}>
            <strong>{apiContract[id].method}</strong>{' '}
            <code>
              {buildPath(id, { id: 1, section: 'sync', action: 'scan', target: 'reboot' })}
            </code>{' '}
            — {apiContract[id].summary}
          </li>
        ))}
      </ul>
    </main>
  );
}
