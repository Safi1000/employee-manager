// The camera and the phone's position, as the field functions want them.
//
// Photos come from the CAMERA ONLY — there is no gallery picker anywhere in the
// app, so a photo cannot be recycled from last week (DECIDED 28 Oct). Each one
// is shrunk on the phone to 1024 px wide and sent as a JPEG data URL, which is
// how Bastion already stores guard photos (0614: field_photos / photo_url).
//
// Position is recorded and compared with the site's area on the server; it
// never blocks anything (0614). If the supervisor refuses location, or the GPS
// has no fix within a few seconds, the submission goes without it.
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as Location from "expo-location";

export type Geo = { lat: number; lng: number; accuracy: number | null };

/** Take one photo with the camera; null if cancelled. Throws a sentence the screen can show. */
export async function takePhoto(width = 1024): Promise<string | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Allow the camera for GGS Field in your phone's settings to take photos.");
  const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1, allowsEditing: false, exif: false });
  if (shot.canceled || !shot.assets?.[0]?.uri) return null;
  const img = await ImageManipulator.manipulate(shot.assets[0].uri).resize({ width }).renderAsync();
  const out = await img.saveAsync({ compress: 0.6, format: SaveFormat.JPEG, base64: true });
  if (!out.base64) throw new Error("A photo did not come through. Take it again.");
  return `data:image/jpeg;base64,${out.base64}`;
}

/** Where the phone is, or null. Never throws and never waits more than ~8 seconds. */
export async function position(): Promise<Geo | null> {
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return null;
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    if (!fix) {
      const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 });
      return last ? { lat: last.coords.latitude, lng: last.coords.longitude, accuracy: last.coords.accuracy ?? null } : null;
    }
    return { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: fix.coords.accuracy ?? null };
  } catch {
    return null;
  }
}
