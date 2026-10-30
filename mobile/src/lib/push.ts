// Push notifications (0622): register this phone's Expo push token for the
// signed-in login, so a new expense request reaches the approvers and the
// decision comes back to whoever asked.
//
// It needs the build's push credentials — the EAS project id in app.json
// (extra.eas.projectId), Firebase for Android and the Apple push key for
// iPhone. Until those are in the build there is no token, and this does nothing:
// the Bastion alert on the web still fires. Never throws.
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { supabase } from "./supabase";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function registerPush(): Promise<void> {
  try {
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId) return;
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", { name: "Bastion", importance: Notifications.AndroidImportance.HIGH });
    }
    const perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return;
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (data) await supabase.rpc("field_register_push", { p_token: data, p_platform: Platform.OS });
  } catch {
    // no credentials in this build, or no network — the web alert still fires
  }
}
