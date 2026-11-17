# JNA looks up its own classes, fields and methods by name from native code (Pointer.peer, Structure
# fields, callbacks). Shrinking or renaming them breaks it with
# "UnsatisfiedLinkError: Can't obtain peer field ID for class com.sun.jna.Pointer".
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }
-dontwarn java.awt.**
-dontwarn com.sun.jna.**

# Vosk (wake word) uses JNA to call libvosk.
-keep class org.vosk.** { *; }
