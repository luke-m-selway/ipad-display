---
type: how-to
status: current
---

# Visual setup walkthrough

Use this after the fresh-Mac bootstrap has finished. It covers the manual macOS and iPad steps that cannot be granted automatically.

## 1. Connect and trust the iPad

Connect the iPad to the Mac with a USB data cable. If either device asks whether to trust or allow the connection, approve it.

## 2. Enable Internet Sharing to the iPad USB link

On the Mac, open **System Settings → General → Sharing**, then open the details for **Internet Sharing**.

Set:

- **Share your connection from:** `Wi-Fi`
- **To devices using:** turn on `iPad USB` (some systems may label the device `iPhone USB`)
- turn **Internet Sharing** on, then click **Done**

[<img src="https://beta.ableset.com/images/docs/07-network/sharing-ventura.jpeg" alt="macOS Ventura Internet Sharing settings" width="720">](https://beta.ableset.com/docs/network)

Confirm the private USB network is present:

```bash
~/ipad-display/scripts/ipad doctor
```

The network check should report `192.168.2.1` as present before starting the display.

## 3. Grant Screen Recording for display capture

Run the display once so macOS can register the capture process:

```bash
ipad
```

Then open **System Settings → Privacy & Security → Screen Recording** and enable the entry macOS added for the iPad Display/Electron capture process. If macOS asks you to quit or restart the process, do so, then start `ipad` again.

[<img src="https://help.coviu.com/hubfs/Screenshot%202023-03-27%20at%204-58-47%20pm-png-1.png" alt="macOS Ventura Screen Recording privacy settings" width="720">](https://help.coviu.com/knowledge/enabling-screen-recording/sharing-for-mac-os-ventura)

## 4. Open the viewer on the iPad

With `ipad` running, open this address in iPad Safari:

```text
http://192.168.2.1:3131/
```

For the normal full-screen workflow, tap Safari's **Share** button, choose **Add to Home Screen**, add it, then launch the saved Home Screen viewer.

[<img src="https://cdn.checkie.org/logos/ipad_setup1.webp" alt="iPad Safari Add to Home Screen action" width="620">](https://checkie.org/)

When display-only mode is working, stop it before testing touch:

```bash
ipad stop
```

## 5. Grant Accessibility for touch mode

Start touch mode once:

```bash
ipad touch
```

Open **System Settings → Privacy & Security → Accessibility** and enable the entry macOS adds for the iPad touch helper. Restart `ipad touch` if macOS asks you to restart the process after granting permission.

[<img src="https://usercontent.cdn.cycling74.com/54da727d306ab0fb18bbbd9a/2025-02-11T21%3A24%3A49Z/Screenshot%202025-02-11%20at%204.20.14%E2%80%AFPM.png" alt="macOS Accessibility privacy settings" width="720">](https://cycling74.com/ja/forums/standalone-mac-permissions-launch-problem)

The first three-finger Mission Control or Spaces gesture may also make macOS ask whether the helper may control **System Events**. Approve that Automation request if it appears.

## 6. Final checks

Display-only:

```bash
ipad
ipad status
ipad stop
```

Touch:

```bash
ipad touch
ipad status
ipad touch stop
```

Finally run:

```bash
~/ipad-display/scripts/ipad doctor
```

Plain `ipad` is always display-only. Touch control is enabled only by the explicit `ipad touch` command.
