import { configPkg } from '@adonisjs/eslint-config'
export default configPkg({
  ignores: ['coverage', '.benchmarks/**', 'packages/core/build/**', 'packages/adonis/dist/**'],
})
