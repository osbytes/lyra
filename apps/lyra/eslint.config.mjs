// @ts-check
import { builtinModules } from 'node:module'
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * Files that still hold `x as T` casts from before the no-casts rule. The rule is an error
 * everywhere else. Remove a file from this list once its casts are gone; never add one.
 * (osbytes playbook: turn a rule on for new code and cap the existing count so it only goes down.)
 */
const CAST_BASELINE = [
  'src/main/meeting/notesFormat.ts',
  'src/main/meeting/notesWorker.ts',
  'src/main/meeting/pipeline.ts',
  'src/main/meeting/worker.ts',
  'src/main/pages.ts',
  'src/main/session.ts',
  'src/main/sessionStore.ts',
  'src/main/settings.ts',
  'src/main/tasks/screenshot.ts',
  'src/main/tasks/smoke.ts',
  'src/main/whisper.ts',
  'src/renderer/src/components/Settings.tsx',
  'src/renderer/src/lib/log.ts',
  'src/shared/sessionDoc.ts',
  'src/shared/transcriptOverlay.ts'
]

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'build/**', 'docs/**'] },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // No `any`, explicit or leaked in from untyped values. Use `unknown` and narrow.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 }
      ],

      // Type-only imports stay type-only, so bundles never pull in a module for its types.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],

      // Every promise is awaited, returned, or explicitly `void`-ed.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } }
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true }
      ],
      // `onClick={() => void save()}` style handlers are fine.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      // `a || b` on strings is deliberate (empty string falls back), so allow it in ternaries.
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignoreTernaryTests: true }],
      // Electron hands out class instances from factories and events (Menu.buildFromTemplate,
      // BrowserWindow from 'browser-window-created'), which this rule misreports as unsafe.
      '@typescript-eslint/no-unsafe-class-instance-assignment': 'off',
      // A union gains a member: every switch over it must say what to do (no silent default).
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Narrow instead of casting (`as const` is fine); see .agents/rules/typescript.md.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      eqeqeq: ['error', 'always'],
      // Rules are errors or off: logging goes through log(), never the console.
      'no-console': 'error'
    }
  },

  {
    files: CAST_BASELINE,
    rules: {
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'allow' }
      ]
    }
  },

  {
    // Configuration comes from config.ts, which parses the environment once at startup.
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    ignores: ['src/main/config.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read configuration through config() in src/main/config.ts.' }
      ]
    }
  },

  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'electron.vite.config.ts'],
    languageOptions: { globals: globals.node }
  },

  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error'
    }
  },

  {
    // The process boundary (AGENTS.md): the renderer and the code it shares with main run in the
    // browser sandbox, so they reach Node and Electron only through window.api (preload). Unit
    // tests run under Node in vitest, not in the window, so they may read fixtures from disk.
    files: ['src/renderer/**/*.{ts,tsx}', 'src/shared/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...['electron', ...builtinModules.filter((name) => !name.startsWith('_'))].map(
              (name) => ({ name, message: 'The renderer reaches Node and Electron through window.api.' })
            )
          ],
          patterns: [
            {
              group: ['node:*', 'electron/*'],
              message: 'The renderer reaches Node and Electron through window.api.'
            },
            {
              regex: '(^|/)(main|preload)(/|$)',
              message: 'Main-process code runs in another process: add an IPC channel (add-ipc-channel skill).'
            }
          ]
        }
      ]
    }
  },

  {
    // Logging modules are the one place that writes to the console.
    files: ['src/**/log.ts'],
    rules: { 'no-console': 'off' }
  },

  {
    // Plain Node scripts: no type information.
    files: ['**/*.{js,cjs,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off'
    }
  },
  {
    files: ['**/*.{js,cjs}'],
    languageOptions: { sourceType: 'commonjs' }
  }
)
