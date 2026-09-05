#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static BOOL mouseIsDown = NO;
static CGPoint lastLocation;

static BOOL accessibilityTrusted(BOOL requestPrompt) {
    NSDictionary *options = requestPrompt
        ? @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES}
        : @{};
    return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
}

static void moveMouseToCurrentLocation(void) {
    CGEventRef event = CGEventCreate(NULL);
    if (!event) return;
    CGPoint location = CGEventGetLocation(event);
    CFRelease(event);

    CGEventRef movement = CGEventCreateMouseEvent(
        NULL, kCGEventMouseMoved, location, kCGMouseButtonLeft);
    if (!movement) return;
    CGEventPost(kCGHIDEventTap, movement);
    CFRelease(movement);
}

static BOOL parseNumber(NSString *value, CGFloat *result) {
    NSScanner *scanner = [NSScanner scannerWithString:value];
    double parsed = 0;
    if (![scanner scanDouble:&parsed] || !scanner.isAtEnd || !isfinite(parsed)) return NO;
    *result = (CGFloat)parsed;
    return YES;
}

static void postMouse(CGEventType type, CGPoint location) {
    CGEventRef event = CGEventCreateMouseEvent(NULL, type, location, kCGMouseButtonLeft);
    if (!event) return;
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
}

static void moveMouse(CGPoint location) {
    postMouse(kCGEventMouseMoved, location);
    lastLocation = location;
}

static void releaseMouse(void) {
    if (!mouseIsDown) return;
    postMouse(kCGEventLeftMouseUp, lastLocation);
    mouseIsDown = NO;
}

static void handleCommand(NSArray<NSString *> *parts) {
    NSString *command = parts.firstObject;
    if ([command isEqualToString:@"release"] && parts.count == 1) {
        releaseMouse();
        return;
    }
    if ([command isEqualToString:@"move"] && parts.count == 3) {
        CGFloat x, y;
        if (parseNumber(parts[1], &x) && parseNumber(parts[2], &y)) moveMouse(CGPointMake(x, y));
        return;
    }
    if (([command isEqualToString:@"click"] || [command isEqualToString:@"down"] ||
         [command isEqualToString:@"up"] || [command isEqualToString:@"drag"]) && parts.count == 3) {
        CGFloat x, y;
        if (!parseNumber(parts[1], &x) || !parseNumber(parts[2], &y)) return;
        CGPoint location = CGPointMake(x, y);
        if ([command isEqualToString:@"click"]) {
            releaseMouse();
            moveMouse(location);
            postMouse(kCGEventLeftMouseDown, location);
            postMouse(kCGEventLeftMouseUp, location);
        } else if ([command isEqualToString:@"down"]) {
            if (!mouseIsDown) {
                moveMouse(location);
                postMouse(kCGEventLeftMouseDown, location);
                mouseIsDown = YES;
            }
        } else if ([command isEqualToString:@"up"]) {
            moveMouse(location);
            releaseMouse();
        } else if (mouseIsDown) {
            postMouse(kCGEventLeftMouseDragged, location);
            lastLocation = location;
        }
        return;
    }
    if ([command isEqualToString:@"scroll"] && parts.count == 5) {
        CGFloat x, y, deltaX, deltaY;
        if (!parseNumber(parts[1], &x) || !parseNumber(parts[2], &y) ||
            !parseNumber(parts[3], &deltaX) || !parseNumber(parts[4], &deltaY)) return;
        moveMouse(CGPointMake(x, y));
        CGEventRef event = CGEventCreateScrollWheelEvent(
            NULL, kCGScrollEventUnitPixel, 2, (int32_t)llround(deltaY), (int32_t)llround(deltaX));
        if (!event) return;
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        BOOL spike = argc == 2 && strcmp(argv[1], "--accessibility-spike") == 0;
        BOOL trusted = accessibilityTrusted(YES);
        fprintf(stderr, "accessibility-trusted=%s\n", trusted ? "yes" : "no");
        if (!trusted) return 2;

        if (spike) {
            // Moving to the existing pointer position proves event posting without changing state.
            moveMouseToCurrentLocation();
            fprintf(stderr, "mouse-movement-posted=yes\n");
        }
        lastLocation = CGPointZero;
        char *line = NULL;
        size_t lineCapacity = 0;
        while (getline(&line, &lineCapacity, stdin) != -1) {
            NSString *input = [NSString stringWithUTF8String:line];
            NSArray<NSString *> *parts = [input componentsSeparatedByCharactersInSet:
                [NSCharacterSet whitespaceAndNewlineCharacterSet]];
            NSMutableArray<NSString *> *tokens = [NSMutableArray array];
            for (NSString *part in parts) if (part.length > 0) [tokens addObject:part];
            handleCommand(tokens);
        }
        free(line);
        // EOF is the host ownership boundary. Never leave a remote drag held.
        releaseMouse();
        return 0;
    }
}
