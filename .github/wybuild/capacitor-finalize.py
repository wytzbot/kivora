#!/usr/bin/env python3
"""Apply WyBuild signing, permissions and optional Firebase configuration to a generated Capacitor Android project."""
import json, os, re, shutil, sys
from pathlib import Path

project = Path(sys.argv[1]).resolve()
config = json.loads(os.environ.get('TWA_CONFIG', '{}') or '{}')
manifest = project / 'app/src/main/AndroidManifest.xml'
gradle = project / 'app/build.gradle'
root_gradle = project / 'build.gradle'
ks = Path(os.environ.get('WB_KEYSTORE_PATH', ''))

def add_permissions(path, names):
    txt = path.read_text(encoding='utf-8')
    existing = set(re.findall(r'<uses-permission[^>]+android:name="([^"]+)"', txt))
    insert = []
    for name in names:
        if name and name not in existing:
            insert.append(f'    <uses-permission android:name="{name}" />')
    # Camera/mic/location remain optional hardware so apps are not excluded from tablets or devices without them.
    if 'android.permission.CAMERA' in names and 'android.hardware.camera.any' not in txt:
        insert.append('    <uses-feature android:name="android.hardware.camera.any" android:required="false" />')
    if 'android.permission.RECORD_AUDIO' in names and 'android.hardware.microphone' not in txt:
        insert.append('    <uses-feature android:name="android.hardware.microphone" android:required="false" />')
    if 'android.permission.ACCESS_FINE_LOCATION' in names and 'android.hardware.location.gps' not in txt:
        insert.append('    <uses-feature android:name="android.hardware.location.gps" android:required="false" />')
    if insert:
        txt = txt.replace('<manifest', '<manifest', 1)
        pos = txt.find('>', txt.find('<manifest')) + 1
        txt = txt[:pos] + '\n' + '\n'.join(insert) + txt[pos:]
        path.write_text(txt, encoding='utf-8')

permissions = set(config.get('androidPermissions') or [])
if config.get('enableNotifications') or any(f in (config.get('nativeFeatures') or []) for f in ('reminders', 'push')):
    permissions.add('POST_NOTIFICATIONS')
permission_aliases = {
 'CAMERA':'android.permission.CAMERA','RECORD_AUDIO':'android.permission.RECORD_AUDIO',
 'ACCESS_FINE_LOCATION':'android.permission.ACCESS_FINE_LOCATION','ACCESS_COARSE_LOCATION':'android.permission.ACCESS_COARSE_LOCATION',
 'POST_NOTIFICATIONS':'android.permission.POST_NOTIFICATIONS','VIBRATE':'android.permission.VIBRATE',
 'READ_CONTACTS':'android.permission.READ_CONTACTS','WRITE_CONTACTS':'android.permission.WRITE_CONTACTS',
 'READ_CALENDAR':'android.permission.READ_CALENDAR','WRITE_CALENDAR':'android.permission.WRITE_CALENDAR',
 'READ_MEDIA_IMAGES':'android.permission.READ_MEDIA_IMAGES','READ_MEDIA_VIDEO':'android.permission.READ_MEDIA_VIDEO',
 'READ_MEDIA_AUDIO':'android.permission.READ_MEDIA_AUDIO','BLUETOOTH_CONNECT':'android.permission.BLUETOOTH_CONNECT',
 'BLUETOOTH_SCAN':'android.permission.BLUETOOTH_SCAN','NFC':'android.permission.NFC',
 'ACTIVITY_RECOGNITION':'android.permission.ACTIVITY_RECOGNITION','BODY_SENSORS':'android.permission.BODY_SENSORS',
 'USE_BIOMETRIC':'android.permission.USE_BIOMETRIC','SCHEDULE_EXACT_ALARM':'android.permission.SCHEDULE_EXACT_ALARM',
 'INTERNET':'android.permission.INTERNET','ACCESS_NETWORK_STATE':'android.permission.ACCESS_NETWORK_STATE',
}
names = [permission_aliases.get(p, p if p.startswith('android.permission.') else ('android.permission.' + p if re.fullmatch(r'[A-Z][A-Z0-9_]*', p) else '')) for p in permissions]
if 'biometric' in (config.get('nativeFeatures') or []): names.append('android.permission.USE_BIOMETRIC')
if 'reminders' in (config.get('nativeFeatures') or []): names += ['android.permission.POST_NOTIFICATIONS','android.permission.VIBRATE']
if manifest.exists(): add_permissions(manifest, sorted(set(names)))

# Use the existing signing identity so updates remain installable over earlier WyBuild releases.
if not gradle.exists(): raise SystemExit(f'Expected Capacitor Gradle file is missing: {gradle}')
# Keep package/version metadata aligned with the WyBuild UI settings and ensure each default build is unique.
meta_path = Path(os.environ.get('GITHUB_WORKSPACE','')) / '.wybuild-out' / 'capacitor-meta.json'
meta = json.loads(meta_path.read_text(encoding='utf-8')) if meta_path.exists() else {}
gradle_text = gradle.read_text(encoding='utf-8')
if re.search(r'versionCode\s*=?\s*\d+', gradle_text):
    gradle_text = re.sub(r'versionCode\s*=?\s*\d+', f"versionCode {int(meta.get('versionCode', 1))}", gradle_text, count=1)
if re.search(r'versionName\s*=?\s*[\"\'][^\"\']*[\"\']', gradle_text):
    gradle_text = re.sub(r'versionName\s*=?\s*[\"\'][^\"\']*[\"\']', f'versionName "{str(meta.get("versionName", "1.0.0"))}"', gradle_text, count=1)
gradle.write_text(gradle_text, encoding='utf-8')
ks_rel = os.path.relpath(ks, project).replace('\\','/')
props = project / 'wybuild-signing.properties'
def java_property_escape(value):
    # java.util.Properties syntax treats backslashes and leading spaces specially.
    value = str(value).replace('\\', '\\\\').replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t')
    value = re.sub(r'([=:#!])', r'\\\1', value)
    if value.startswith(' '): value = '\\' + value
    return value
props.write_text('\n'.join([
  'storeFile=' + java_property_escape(ks_rel),
  'storePassword=' + java_property_escape(os.environ.get('BUBBLEWRAP_KEYSTORE_PASSWORD','')),
  'keyAlias=' + java_property_escape(os.environ.get('WB_KEY_ALIAS','')),
  'keyPassword=' + java_property_escape(os.environ.get('BUBBLEWRAP_KEY_PASSWORD','')),
]) + '\n', encoding='utf-8')

g = gradle.read_text(encoding='utf-8')
if 'wybuild-signing.properties' not in g:
    signing = '''\n// Added by WyBuild: release builds use the same stable upload key for app updates.\ndef wybuildSigningFile = rootProject.file("wybuild-signing.properties")\ndef wybuildSigning = new java.util.Properties()\nif (wybuildSigningFile.exists()) { wybuildSigning.load(new FileInputStream(wybuildSigningFile)) }\nandroid {\n    signingConfigs {\n        release {\n            if (wybuildSigningFile.exists()) {\n                storeFile rootProject.file(wybuildSigning['storeFile'])\n                storePassword wybuildSigning['storePassword']\n                keyAlias wybuildSigning['keyAlias']\n                keyPassword wybuildSigning['keyPassword']\n                enableV1Signing = true\n                enableV2Signing = true\n                enableV3Signing = true\n                enableV4Signing = false\n            }\n        }\n    }\n    buildTypes {\n        release { signingConfig signingConfigs.release }\n    }\n}\n'''
    # Keep imports at the top; Groovy allows imports before statements only.
    g += signing
    gradle.write_text(g, encoding='utf-8')

# If Firebase Android config is present, wire Google's Gradle plugin so native Google sign-in and FCM can work.
workspace = Path(os.environ.get('GITHUB_WORKSPACE',''))
# Firebase client config may live at the repo root, under config/android (WyCut layout), in android/app, or arrive as a base64 variable.
source_google = workspace / 'google-services.json'
for candidate in ('google-services.json', 'config/android/google-services.json', 'android/app/google-services.json', 'app/google-services.json'):
    if (workspace / candidate).exists():
        source_google = workspace / candidate
        break
else:
    b64 = os.environ.get('GOOGLE_SERVICES_JSON_BASE64', '').strip()
    if b64:
        import base64
        source_google = workspace / '.wybuild-out' / 'google-services.json'
        source_google.parent.mkdir(parents=True, exist_ok=True)
        source_google.write_bytes(base64.b64decode(b64))
# Incoming Android share target: declare Android SEND intents when enabled.


if 'sharetarget' in (config.get('nativeFeatures') or []) and manifest.exists():
    manifest_text = manifest.read_text(encoding='utf-8')
    activity_match = re.search(r'<activity\\b(?=[^>]*android:name="[^"]*MainActivity")[^>]*>', manifest_text)
    if activity_match and 'android.intent.action.SEND' not in manifest_text:
        filters = '''
        <intent-filter>
            <action android:name="android.intent.action.SEND" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="text/plain" />
        </intent-filter>
        <intent-filter>
            <action android:name="android.intent.action.SEND" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="text/*" />
        </intent-filter>
        <intent-filter>
            <action android:name="android.intent.action.SEND" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="image/*" />
        </intent-filter>
        <intent-filter>
            <action android:name="android.intent.action.SEND" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="application/pdf" />
        </intent-filter>
        <intent-filter>
            <action android:name="android.intent.action.SEND_MULTIPLE" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="image/*" />
        </intent-filter>
'''
        manifest_text = manifest_text[:activity_match.end()] + filters + manifest_text[activity_match.end():]
        manifest.write_text(manifest_text, encoding='utf-8')

    # Capacitor plugin exposes incoming share intent extras to the website.
    java_root = project / 'app/src/main/java'
    plugin_dir = java_root / 'com/wybuild/sharetarget'
    plugin_dir.mkdir(parents=True, exist_ok=True)
    plugin_java = plugin_dir / 'WyBuildShareTargetPlugin.java'
    plugin_java.write_text('''package com.wybuild.sharetarget;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;

@CapacitorPlugin(name = "WyBuildShareTarget")
public class WyBuildShareTargetPlugin extends Plugin {
  @PluginMethod public void getSharedContent(PluginCall call) {
    Intent intent = getActivity().getIntent();
    JSObject result = new JSObject();
    if (intent == null) { result.put("action", ""); call.resolve(result); return; }
    result.put("action", intent.getAction() == null ? "" : intent.getAction());
    result.put("mimeType", intent.getType() == null ? "" : intent.getType());
    String text = intent.getStringExtra(Intent.EXTRA_TEXT);
    if (text != null) result.put("text", text);
    String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
    if (subject != null) result.put("subject", subject);
    JSONArray uris = new JSONArray();
    Uri single = intent.getParcelableExtra(Intent.EXTRA_STREAM);
    if (single != null) uris.put(single.toString());
    if (intent.getClipData() != null) {
      for (int i = 0; i < intent.getClipData().getItemCount(); i++) {
        Uri uri = intent.getClipData().getItemAt(i).getUri();
        if (uri != null && !uris.toString().contains(uri.toString())) uris.put(uri.toString());
      }
    }
    result.put("uris", uris);
    call.resolve(result);
  }
}
''', encoding='utf-8')
    for main_activity in java_root.rglob('MainActivity.java'):
        source = main_activity.read_text(encoding='utf-8')
        if 'WyBuildShareTargetPlugin' not in source:
            source = source.replace('import com.getcapacitor.BridgeActivity;', 'import com.getcapacitor.BridgeActivity;\nimport com.wybuild.sharetarget.WyBuildShareTargetPlugin;')
            if 'import com.wybuild.sharetarget.WyBuildShareTargetPlugin;' in source and 'registerPlugin(WyBuildShareTargetPlugin.class)' not in source:
                source = re.sub(r'(public class MainActivity extends BridgeActivity\s*\{)', r'\1\n    @Override\n    public void onCreate(android.os.Bundle savedInstanceState) {\n        registerPlugin(WyBuildShareTargetPlugin.class);\n        super.onCreate(savedInstanceState);\n    }\n    @Override\n    protected void onNewIntent(android.content.Intent intent) {\n        super.onNewIntent(intent);\n        setIntent(intent);\n    }', source, count=1)
            main_activity.write_text(source, encoding='utf-8')

if any(f in (config.get('nativeFeatures') or []) for f in ('googleauth', 'push')) and not source_google.exists():
    raise SystemExit('Native Google/Apple sign-in or remote push was selected, but google-services.json is missing at the repository root. Add the Firebase Android config for the exact package ID and rebuild.')

if source_google.exists():
    # Fail early when Firebase config belongs to a different Android application ID.
    try:
        firebase_cfg = json.loads(source_google.read_text(encoding='utf-8'))
        firebase_packages = {c.get('client_info', {}).get('android_client_info', {}).get('package_name') for c in firebase_cfg.get('client', [])}
        if firebase_packages and meta.get('packageId') not in firebase_packages:
            raise SystemExit(f'google-services.json package name does not match WyBuild package ID {meta.get("packageId")}. Add the Firebase Android app for this exact package ID.')
    except json.JSONDecodeError as exc:
        raise SystemExit(f'google-services.json is not valid JSON: {exc}')
    shutil.copy2(source_google, project / 'app/google-services.json')
    # Native Google sign-in only works when the APK's signing SHA-1 is registered for this package in Firebase.
    try:
        import subprocess
        registered = {o.get('android_info', {}).get('certificate_hash', '').lower()
                      for c in firebase_cfg.get('client', [])
                      if c.get('client_info', {}).get('android_client_info', {}).get('package_name') == meta.get('packageId')
                      for o in c.get('oauth_client', []) if o.get('client_type') == 1 and o.get('android_info')}
        if os.environ.get('SIGN_MODE') == 'remote':
            print('::notice::Release signing is done by WyBuild after this build; make sure its SHA-1 is registered in Firebase for ' + str(meta.get('packageId')) + '.')
        elif ks.exists():
            out = subprocess.run(['keytool', '-list', '-v', '-keystore', str(ks), '-alias', os.environ.get('WB_KEY_ALIAS', ''), '-storepass', os.environ.get('BUBBLEWRAP_KEYSTORE_PASSWORD', '')], capture_output=True, text=True).stdout
            m = re.search(r'SHA1:\s*([0-9A-Fa-f:]+)', out)
            sha1 = m.group(1).replace(':', '').lower() if m else ''
            if sha1 and sha1 not in registered:
                print(f'::warning::Native Google sign-in will fail with DEVELOPER_ERROR: this build is signed with SHA-1 {m.group(1)}, which is not registered for {meta.get("packageId")} in google-services.json. Add it in Firebase > Project settings > your Android app > Add fingerprint, download a fresh google-services.json, commit it, and rebuild.')
    except Exception as exc:  # diagnostics only
        print(f'::notice::Could not check the Firebase SHA-1 registration: {exc}')
    if root_gradle.exists():
        rg = root_gradle.read_text(encoding='utf-8')
        if 'com.google.gms.google-services' not in rg and 'com.google.gms:google-services' not in rg:
            # Prefer the modern plugins DSL when the template uses it. Otherwise add the
            # classpath inside the existing buildscript dependencies block (never append a
            # second, late buildscript block that can break Gradle's script ordering).
            plugins_match = re.search(r'(?m)^\s*plugins\s*\{', rg)
            if plugins_match:
                pos = plugins_match.end()
                rg = rg[:pos] + "\n    id 'com.google.gms.google-services' version '4.4.2' apply false" + rg[pos:]
            else:
                dep_match = re.search(r'(?s)(buildscript\s*\{.*?dependencies\s*\{)', rg)
                if dep_match:
                    pos = dep_match.end()
                    rg = rg[:pos] + "\n        classpath 'com.google.gms:google-services:4.4.2'" + rg[pos:]
                else:
                    rg = "buildscript { repositories { google(); mavenCentral() }; dependencies { classpath 'com.google.gms:google-services:4.4.2' } }\n" + rg
            root_gradle.write_text(rg, encoding='utf-8')
    g = gradle.read_text(encoding='utf-8')
    if 'com.google.gms.google-services' not in g:
        g += "\napply plugin: 'com.google.gms.google-services'\n"
        gradle.write_text(g, encoding='utf-8')
# Enable the Firebase Authentication plugin's Google provider. Without this the plugin's GoogleAuthProviderHandler is null and
# sign-in crashes with "Attempt to invoke virtual method ... GoogleAuthProviderHandler.signIn ... on a null object reference".
try:
    # 1) project variable that compiles the Google provider into the plugin
    var_gradle = project / 'variables.gradle'
    if var_gradle.exists():
        vg = var_gradle.read_text(encoding='utf-8')
        if 'rgcfaIncludeGoogle' not in vg:
            vg = re.sub(r'(ext\s*\{)', r'\1\n    rgcfaIncludeGoogle = true', vg, count=1)
            var_gradle.write_text(vg, encoding='utf-8')
    # 2) runtime plugin config inside the APK assets
    for cfg_path in (project / 'app/src/main/assets/capacitor.config.json', project / 'capacitor.config.json'):
        if cfg_path.exists():
            cj = json.loads(cfg_path.read_text(encoding='utf-8'))
            fa = cj.setdefault('plugins', {}).setdefault('FirebaseAuthentication', {})
            providers = set(fa.get('providers') or [])
            providers.add('google.com')
            fa['providers'] = sorted(providers)
            cfg_path.write_text(json.dumps(cj, indent=2), encoding='utf-8')
except Exception as exc:
    print(f'::warning::Could not enable the Google sign-in provider automatically: {exc}')

print('WyBuild Capacitor Android project finalized: release signing and requested permissions configured.')
