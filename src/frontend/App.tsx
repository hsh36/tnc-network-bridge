import { API_BASE_PATH, PRODUCT_NAME } from '../shared/constants';

/**
 * Placeholder shell. The real application layout, routing and auth guard land in T32.
 * Its only job today is to prove the frontend builds and can import `src/shared`
 * with zero backend imports (T1/T2 acceptance criteria).
 */
export function App(): JSX.Element {
  return (
    <main>
      <h1>{PRODUCT_NAME}</h1>
      <p>API base path: {API_BASE_PATH}</p>
    </main>
  );
}
