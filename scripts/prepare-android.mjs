import fs from 'node:fs';
import path from 'node:path';

const manifestPath = path.resolve('android/app/src/main/AndroidManifest.xml');
if (!fs.existsSync(manifestPath)) {
  console.error('Android project is missing. Run: npm run android:setup');
  process.exit(1);
}

let xml = fs.readFileSync(manifestPath, 'utf8');

// Block cleartext (http) traffic. Idempotent: only add if the attribute is absent.
if (!/android:usesCleartextTraffic=/.test(xml)) {
  xml = xml.replace('<application ', '<application android:usesCleartextTraffic="false" ');
}
if (!/android:resizeableActivity=/.test(xml)) {
  xml = xml.replace('<application ', '<application android:resizeableActivity="true" ');
}

// Capacitor 8 requires "density" in configChanges. The stock template already has it,
// so only patch when it is missing.
xml = xml.replace(/android:configChanges="([^"]*)"/, (match, value) =>
  value.split('|').includes('density') ? match : `android:configChanges="${value}|density"`
);

// INTERNET permission is a child element of <manifest>, so it must go before
// <application>, not inside the <manifest ...> start tag.
if (!xml.includes('android.permission.INTERNET')) {
  xml = xml.replace(
    '<application',
    '<uses-permission android:name="android.permission.INTERNET" />\n\n    <application'
  );
}
fs.writeFileSync(manifestPath, xml);

const gradleProps = path.resolve('android/gradle.properties');
if (fs.existsSync(gradleProps)) {
  let gp = fs.readFileSync(gradleProps, 'utf8');
  if (!gp.includes('android.useAndroidX=true')) gp += '\nandroid.useAndroidX=true\n';
  fs.writeFileSync(gradleProps, gp);
}

console.log('Android manifest prepared.');
