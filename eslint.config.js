import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

/**
 * The float ban.
 *
 * The core schema spec forbids floating-point arithmetic anywhere near money or quantities.
 * Branded types in src/domain/numeric.ts catch most violations at compile time, but a few
 * constructs slip past the type system by producing a fresh `number` from a string. Those are
 * banned here.
 *
 * Exactly two directories are exempt, and both are listed explicitly below rather than being
 * matched by a loose pattern.
 */
const FLOAT_BAN = [
  {
    selector: "CallExpression[callee.name='parseFloat']",
    message:
      'parseFloat destroys precision. Use dec() or minor() from @domain/numeric, and the decimal helpers for arithmetic.',
  },
  {
    selector: "CallExpression[callee.name='parseInt']",
    message:
      'parseInt truncates silently. Use minor() from @domain/numeric, or BigInt for integer parsing.',
  },
  {
    selector:
      "CallExpression[callee.object.name='Number'][callee.property.name=/^(parseInt|parseFloat)$/]",
    message:
      'Number.parseInt/parseFloat are aliases of the globals and destroy precision identically. Use @domain/numeric.',
  },
  {
    selector: "CallExpression[callee.name='Number']",
    message:
      'Number() produces a float. Money and quantities stay as Minor/Dec strings; see @domain/numeric.',
  },
  {
    selector: "UnaryExpression[operator='+'][argument.type!='Literal']",
    message:
      'Unary + coerces to float. Use the arithmetic helpers in @domain/numeric.',
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name=/^(round|floor|ceil|abs|max|min|pow)$/]",
    message:
      'Math.* operates on floats. Use the decimal helpers in @domain/numeric for any value derived from money or quantities.',
  },
  {
    selector: "CallExpression[callee.property.name='toFixed']",
    message:
      'toFixed() implies a float. Format via the display helpers, which round only at the display boundary.',
  },
]

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src-tauri/target', 'docs/design/mockups'] },

  js.configs.recommended,

  // Type-aware rules apply only to files inside the TypeScript project. Applying them to
  // config files such as this one fails, because they are not in tsconfig's `include`.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
  })),

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-syntax': ['error', ...FLOAT_BAN],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
    },
  },

  // The numeric module is the one place decimal.js and BigInt conversions legitimately live.
  // It is small, heavily tested, and reviewed as the trusted base for everything above it.
  {
    files: ['src/domain/numeric.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // Chart geometry converts a decimal to a number exactly once, to compute pixel positions.
  // Labels in these files must still be rendered from the original Dec or Minor.
  {
    files: ['src/ui/charts/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...FLOAT_BAN.filter((r) => !r.selector.includes('Math')),
      ],
    },
  },

  // Tests construct fixtures and assert on numbers; the ban would obstruct without protecting.
  {
    files: ['**/*.test.{ts,tsx}', 'tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
)
