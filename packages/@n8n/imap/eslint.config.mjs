import { defineConfig } from 'eslint/config';
import { baseConfig } from '@n8n/eslint-config/base';

export default defineConfig(baseConfig, {
	rules: {
		'unicorn/filename-case': ['error', { case: 'kebabCase' }],
		'@typescript-eslint/consistent-type-imports': 'error',
		'n8n-local-rules/no-plain-errors': 'off',

		// TODO: Remove this
		'@typescript-eslint/no-unnecessary-boolean-literal-compare': 'warn',
		'@typescript-eslint/prefer-nullish-coalescing': 'warn',
		'@typescript-eslint/no-floating-promises': 'warn',
		'import-x/order': 'warn',
	},
},
{
	// IMAP atoms and header field names are protocol identifiers, not code ones.
	files: ['src/search-criteria.ts', 'src/search-criteria.test.ts', 'src/headers.test.ts'],
	rules: { '@typescript-eslint/naming-convention': 'off' },
},
{
	// Mocks mirror the exported names and async shapes of what they replace.
	files: ['src/index.test.ts', 'src/imap-simple.test.ts'],
	rules: {
		'@typescript-eslint/naming-convention': 'off',
		'@typescript-eslint/require-await': 'off',
	},
});
