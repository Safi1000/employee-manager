import { defineConfig } from 'vite'
import path from 'path'
import fs from 'fs'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// The identity of this build, compiled into the bundle AND written to
// dist/build-id.json. An open tab compares the one it is running against the one
// the server is serving; when they differ its code is stale. See
// src/app/lib/appUpdate.tsx.
//
// Vercel exposes the commit as VERCEL_GIT_COMMIT_SHA, which is the most useful
// value because it names WHICH push a tab is on. The timestamp fallback covers a
// local or CI build with no git metadata — it only has to be different every
// time, not meaningful.
const BUILD_ID =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  String(Date.now())

// Written in closeBundle rather than emitted as an asset so it lands in dist
// with a FIXED name. A hashed filename would be unfindable by the tab that needs
// to fetch it, which is the whole point of the file.
function buildStamp() {
  return {
    name: 'build-stamp',
    apply: 'build' as const,
    closeBundle() {
      const dir = path.resolve(__dirname, 'dist')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'build-id.json'),
        JSON.stringify({ buildId: BUILD_ID, builtAt: new Date().toISOString() }) + '\n',
      )
    },
  }
}


function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

export default defineConfig({
  plugins: [
    figmaAssetResolver(),
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
    buildStamp(),
  ],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],
})
