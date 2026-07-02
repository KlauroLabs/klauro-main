package com.example.common;

public final class SharedUtils {
    private SharedUtils() {}

    public static String normalize(String input) {
        return input == null ? "" : input.trim().toLowerCase();
    }
}
