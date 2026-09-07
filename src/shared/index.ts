/**
 * The contract between the backend and the frontend.
 *
 * Everything here is compiled into the browser bundle, so this subtree must never
 * import Node built-ins or backend modules. That is enforced twice: `"types": []` in
 * `src/shared/tsconfig.json` and a `no-restricted-imports` rule in the ESLint config.
 */
export * from './constants';
export * from './schemas';
export * from './api-contract';
