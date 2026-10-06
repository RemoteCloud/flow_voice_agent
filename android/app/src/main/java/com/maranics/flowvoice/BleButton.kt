package com.maranics.flowvoice

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.companion.AssociationInfo
import android.companion.AssociationRequest
import android.companion.BluetoothLeDeviceFilter
import android.companion.CompanionDeviceManager
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.Parcelable
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.UUID
import java.util.regex.Pattern

/**
 * A Bluetooth push-to-talk button (Zello-type) that is not a keyboard: it reports a press as a notification on
 * one of its own GATT characteristics. Nothing is known about the button beforehand, so every characteristic that
 * can notify is listened to, and each distinct payload is a key named like the browser names it
 * (`bleKeyName` in server/protocol.ts): "Ble1FFE101" goes down when the button in slot 1 sends 01 on FFE1 and up
 * when it sends anything else. One instance per slot (1–3): buttons of the same make send the same bytes, so the
 * slot is what tells them apart.
 *
 * The button is picked once in the system's own chooser (CompanionDeviceManager: no location permission, no scan
 * of our own), remembered, and reconnected whenever it wakes up. Keyboard-type buttons never come here: Android
 * hands those over as key events (`MainActivity.dispatchKeyEvent`).
 */
@SuppressLint("MissingPermission") // every call is behind `allowed()`
class BleButton(private val activity: Activity, val slot: Int, private val onKey: (key: String, down: Boolean) -> Unit, private val onState: () -> Unit, private val onError: (message: String) -> Unit) {
    private val prefs = activity.getSharedPreferences("flowvoice", Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())
    private var gatt: BluetoothGatt? = null
    /** Notification switches still to be written; GATT takes one operation at a time. */
    private val pending = ArrayDeque<BluetoothGattDescriptor>()
    /** characteristic → the key that is down on it */
    private val held = HashMap<UUID, String>()

    @Volatile var connected = false
        private set
    private val addressKey = "bleButton$slot"
    private val nameKey = "bleButtonName$slot"
    val name: String get() = prefs.getString(nameKey, "") ?: ""
    private val address: String? get() = prefs.getString(addressKey, null)
    fun sameDevice(mac: String): Boolean = address.equals(mac, ignoreCase = true)

    /** Android 12+: talking to a Bluetooth device needs the "Nearby devices" permission. */
    fun allowed(): Boolean = Build.VERSION.SDK_INT < 31 || ContextCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    /**
     * Show the system chooser; `launch` starts it, the result comes back through `onChosen`. The list is short by
     * default: only devices that look like a button (a button service, or a push-to-talk / remote kind of name), so
     * it is not buried under every headset, watch and TV in reach. `all` lists every Bluetooth LE device.
     */
    fun choose(all: Boolean, launch: (IntentSender) -> Unit) {
        val cdm = activity.getSystemService(CompanionDeviceManager::class.java)
        if (cdm == null || !activity.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
            onError("This device has no Bluetooth LE")
            return
        }
        val builder = AssociationRequest.Builder().setSingleDevice(false)
        if (all) builder.addDeviceFilter(BluetoothLeDeviceFilter.Builder().build())
        else {
            builder.addDeviceFilter(BluetoothLeDeviceFilter.Builder().setNamePattern(BUTTON_NAMES).build())
            for (service in BUTTON_SERVICES) builder.addDeviceFilter(BluetoothLeDeviceFilter.Builder().setScanFilter(ScanFilter.Builder().setServiceUuid(ParcelUuid(service)).build()).build())
        }
        val request = builder.build()
        cdm.associate(request, object : CompanionDeviceManager.Callback() {
            // Android 13+ calls onAssociationPending, whose default hands over to this one
            @Deprecated("Deprecated in Java")
            override fun onDeviceFound(chooserLauncher: IntentSender) = launch(chooserLauncher)
            override fun onFailure(error: CharSequence?) = onError(error?.toString() ?: "No Bluetooth button found")
        }, null)
    }

    /** The chooser closed: remember the picked device and connect to it. `taken` says whether another slot already has that device. */
    fun onChosen(data: Intent?, taken: (mac: String) -> Boolean) {
        if (data == null) return
        var device: BluetoothDevice? = null
        @Suppress("DEPRECATION")
        when (val d = data.getParcelableExtra<Parcelable>(CompanionDeviceManager.EXTRA_DEVICE)) {
            is ScanResult -> device = d.device
            is BluetoothDevice -> device = d
        }
        var mac = device?.address
        if (mac == null && Build.VERSION.SDK_INT >= 33) mac = data.getParcelableExtra(CompanionDeviceManager.EXTRA_ASSOCIATION, AssociationInfo::class.java)?.deviceMacAddress?.toString()?.uppercase()
        if (mac == null) {
            onError("No Bluetooth button picked")
            return
        }
        if (taken(mac)) {
            onError("That button is already in use as another button")
            return
        }
        val label = runCatching { device?.name }.getOrNull()?.takeIf { it.isNotBlank() } ?: "Bluetooth button"
        prefs.edit().putString(addressKey, mac).putString(nameKey, label).apply()
        onState()
        connect(device)
    }

    /** Stop using the button in this slot. */
    fun forget() {
        close()
        prefs.edit().remove(addressKey).remove(nameKey).apply()
        onState()
    }

    /** Connect to the remembered button (does nothing when none was picked or the permission is missing). */
    fun connect(known: BluetoothDevice? = null, background: Boolean = false) {
        val mac = address ?: return
        if (!allowed()) return
        val adapter = activity.getSystemService(BluetoothManager::class.java)?.adapter ?: return
        val device = known ?: runCatching { adapter.getRemoteDevice(mac) }.getOrNull() ?: return
        close()
        // background = wait for the button to show up again (it sleeps between uses) instead of timing out
        gatt = device.connectGatt(activity, background, callback, BluetoothDevice.TRANSPORT_LE)
    }

    fun close() {
        main.removeCallbacksAndMessages(null)
        runCatching { gatt?.close() }
        gatt = null
        pending.clear()
        releaseAll()
        connected = false
    }

    private fun releaseAll() {
        val keys = synchronized(held) { held.values.toList().also { held.clear() } }
        for (k in keys) onKey(k, false)
    }

    private fun changed(uuid: UUID, value: ByteArray) {
        val key = bleKeyName(slot, uuid, value)
        Log.d(TAG, "slot $slot: $uuid sent ${value.joinToString("") { "%02X".format(it) }} -> $key")
        // only zeros = let go ("01" down, "00" up): it ends the press and is no key of its own (`bleIsRelease` in server/protocol.ts)
        val release = value.isNotEmpty() && value.all { it == 0.toByte() }
        val was = synchronized(held) { if (release) held.remove(uuid) else held.put(uuid, key) }
        // anything new on the characteristic ends the press before it; the same payload again is a new press (click-only buttons)
        if (was != null) onKey(was, false)
        if (!release) onKey(key, true)
    }

    private fun writeNext(g: BluetoothGatt) {
        val d = pending.removeFirstOrNull() ?: return
        val indicate = d.characteristic.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY == 0
        val value = if (indicate) BluetoothGattDescriptor.ENABLE_INDICATION_VALUE else BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        val ok = if (Build.VERSION.SDK_INT >= 33) g.writeDescriptor(d, value) == 0 else {
            @Suppress("DEPRECATION")
            d.value = value
            @Suppress("DEPRECATION")
            g.writeDescriptor(d)
        }
        Log.d(TAG, "slot $slot: switch on ${d.characteristic.uuid} (${if (indicate) "indicate" else "notify"}) started=$ok")
        if (!ok) writeNext(g)
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (g !== gatt) return
            Log.d(TAG, "slot $slot: connection state $newState status $status")
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                g.discoverServices()
                return
            }
            if (newState != BluetoothProfile.STATE_DISCONNECTED) return
            val was = connected
            connected = false
            releaseAll()
            if (was) onState()
            // out of reach or asleep: start over and let Android connect when the button is back
            main.postDelayed({ if (g === gatt) connect(background = true) }, 1500)
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (g !== gatt) return
            pending.clear()
            for (service in g.services) {
                if (service.uuid in STANDARD) continue
                for (c in service.characteristics) {
                    if (c.properties and (BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_INDICATE) == 0) continue
                    val on = g.setCharacteristicNotification(c, true)
                    Log.d(TAG, "slot $slot: listen to ${c.uuid} props ${c.properties} ok=$on cccd=${c.getDescriptor(CCCD) != null}")
                    c.getDescriptor(CCCD)?.let { pending.add(it) }
                }
            }
            connected = true
            onState()
            writeNext(g)
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            Log.d(TAG, "slot $slot: switch on ${descriptor.characteristic.uuid} done status $status")
            if (g === gatt) writeNext(g)
        }

        @Deprecated("Deprecated in Java")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            if (Build.VERSION.SDK_INT < 33 && g === gatt) changed(characteristic.uuid, characteristic.value ?: ByteArray(0))
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            if (g === gatt) changed(characteristic.uuid, value)
        }
    }

    companion object {
        private const val TAG = "FlowVoiceBle"
        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private fun std(short: String): UUID = UUID.fromString("0000$short-0000-1000-8000-00805f9b34fb")
        /** Services every device has, plus battery and HID (keyboards arrive as key events): never a button press. */
        private val STANDARD = setOf(std("1800"), std("1801"), std("180a"), std("180f"), std("1812"))

        /** What a push-to-talk or remote button is usually called; the short chooser list shows these (and anything on a button service). */
        private val BUTTON_NAMES: Pattern = Pattern.compile(".*(ptt|zello|talk|pryme|aina|inrico|anysecu|seecode|dellking|button|btn|remote|shutter|selfie|itag|key|click|flic|smart|hm-?1|hmsoft|jdy|bt05|cc41|dsd).*", Pattern.CASE_INSENSITIVE)
        /** The serial-style services the common Bluetooth LE button modules use (the same list as web/src/ble.ts). */
        private val BUTTON_SERVICES = listOf(std("ffe0"), std("fff0"), std("ff00"), std("ff10"), std("ffa0"), std("ffb0"), std("ffc0"), std("ffd0"), std("fee0"), UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e"), UUID.fromString("49535343-fe7d-4ae5-8fa9-9fafd205e455"))

        /** Same name as `bleKeyName` in server/protocol.ts: "Ble" + slot + short characteristic id + the first six bytes as hex. */
        fun bleKeyName(slot: Int, uuid: UUID, value: ByteArray): String {
            val s = uuid.toString().lowercase()
            val short = if (s.startsWith("0000") && s.endsWith("-0000-1000-8000-00805f9b34fb")) s.substring(4, 8) else s.replace("-", "").take(8)
            return "Ble" + slot + short.uppercase() + value.take(6).joinToString("") { "%02X".format(it) }
        }
    }
}
