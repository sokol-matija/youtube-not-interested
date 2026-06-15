module.exports = {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@semantic-release/exec', {
      prepareCmd: `node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('manifest.json','utf8'));m.version='\${nextRelease.version}';fs.writeFileSync('manifest.json',JSON.stringify(m,null,2)+'\\n')"`,
    }],
    ['@semantic-release/changelog', {
      changelogFile: 'CHANGELOG.md',
    }],
    ['@semantic-release/git', {
      assets: ['manifest.json', 'CHANGELOG.md'],
      message: 'chore(release): ${nextRelease.version} [skip ci]',
    }],
    '@semantic-release/github',
  ],
};
