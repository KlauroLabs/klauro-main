package app.tasks

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        schedule(context)
    }

    private fun schedule(context: Context) = Unit
}
