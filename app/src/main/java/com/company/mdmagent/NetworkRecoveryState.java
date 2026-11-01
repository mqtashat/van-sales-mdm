package com.company.mdmagent;

/** Tracks validated default-network transitions, including WAN loss on the same Wi-Fi. */
final class NetworkRecoveryState {
    private Object current;
    private boolean validated;

    synchronized void available(Object network) {
        if (!network.equals(current)) {
            current = network;
            validated = false;
        }
    }

    synchronized boolean capabilities(Object network, boolean internetValidated) {
        if (!network.equals(current)) return false;
        boolean recovered = internetValidated && !validated;
        validated = internetValidated;
        return recovered;
    }

    synchronized void lost(Object network) {
        if (network.equals(current)) {
            current = null;
            validated = false;
        }
    }
}
