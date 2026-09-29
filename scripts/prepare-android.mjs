import fs from 'node:fs';
import path from 'node:path';

const manifest = path.resolve('android/app/src/main/AndroidManifest.xml');
if (!fs.existsSync(manifest)) {
  console.error('Android project is missing. Run: npm run android:setup');
  process.exit(1);
}

let xml = fs.readFileSync(manifest, 'utf8');
xml = xml.replace('<application ', '<application android:usesCleartextTraffic="false" android:resizeableActivity="true" ');
xml = xml.replace('android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation"', 'android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density"');
if (!xml.includes('android.permission.INTERNET')) {
  xml = xml.replace('<manifest ', '<manifest ');
  xml = xml.replace(/(xmlns:android="[^"]+")/, '$1\n    ' + '<uses-permission android:name="android.permission.INTERNET" />');
}
fs.writeFileSync(manifest, xml);

const gradleProps = path.resolve('android/gradle.properties');
if (fs.existsSync(gradleProps)) {
  let gp = fs.readFileSync(gradleProps, 'utf8');
  if (!gp.includes('android.useAndroidX=true')) gp += '\nandroid.useAndroidX=true\n';
  if (!gp.includes('android.enableJetifier=true')) gp += 'android.enableJetifier=true\n';
  fs.writeFileSync(gradleProps, gp);
}
