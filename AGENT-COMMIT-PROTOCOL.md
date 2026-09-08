# 🔧 AGENT COMMIT PROTOCOL

**Gültig für: Opus & Sonnet (alle Phasen)**

## Vor JEDEM Git Commit:

```bash
# Step 1: Format Check (REQUIRED FIRST!)
npm run format:check

# If Step 1 fails → fix immediately:
npm run format
git add .  # Re-stage formatted files

# Step 2-4: Verify everything
npm run type-check  # TypeScript
npm run lint        # ESLint
npm run test        # Jest + Vitest
```

**ONLY if ALL 4 checks pass: proceed to commit**

## Commit Pattern

```bash
npm run format:check || { npm run format && git add .; }
npm run type-check && npm run lint && npm run test
git commit -m "feat(T#): description"
git push
```

## Why This Matters

❌ **Problem**: Windows dev → CRLF line endings  
❌ **GitHub CI expects**: LF line endings  
❌ **Result**: CI fails, ugly fix commits

✅ **Solution**: `npm run format` normalizes to LF before commit

## Common Error

```
Code style issues found in N files. Run Prettier with --write to fix.
Error: Process completed with exit code 1.
```

→ This means you skipped `npm run format:check`  
→ Run `npm run format` immediately  
→ Re-stage and recommit

---

**This is NOT optional. Follow it to keep CI green.** ✅
