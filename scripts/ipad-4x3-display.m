#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#include <string.h>
#include <stdlib.h>

static const unsigned int kVirtualDisplaySerial = 0x4321;
// 0x1236 intentionally supersedes 0x1235: Ventura persisted the latter's
// 1440x1080 preference. Keep this replacement identity stable across runs.
static const unsigned int kVirtualDisplayProductID = 0x1236;
static const unsigned int kVirtualDisplayVendorID = 0x3456;
static const size_t kRequiredDisplayWidth = 1600;
static const size_t kRequiredDisplayHeight = 1200;
static const size_t kRequiredBackingWidth = kRequiredDisplayWidth * 2;
static const size_t kRequiredBackingHeight = kRequiredDisplayHeight * 2;

@class CGVirtualDisplayDescriptor;

@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(NSUInteger)width
                       height:(NSUInteger)height
                  refreshRate:(CGFloat)refreshRate;
@end

@interface CGVirtualDisplaySettings : NSObject
@property(retain, nonatomic) NSArray<CGVirtualDisplayMode *> *modes;
@property(nonatomic) unsigned int hiDPI;
@end

@interface CGVirtualDisplay : NSObject
@property(readonly, nonatomic) CGDirectDisplayID displayID;
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@end

@interface CGVirtualDisplayDescriptor : NSObject
@property(retain, nonatomic) dispatch_queue_t queue;
@property(retain, nonatomic) NSString *name;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int serialNum;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int vendorID;
- (void)setDispatchQueue:(dispatch_queue_t)queue;
@end

static NSString *stateFilePathFromArguments(int argc, const char * argv[]) {
    for (int index = 1; index + 1 < argc; index += 1) {
        if (strcmp(argv[index], "--state-file") == 0) {
            return [NSString stringWithUTF8String:argv[index + 1]];
        }
    }
    return nil;
}

static BOOL hasArgument(int argc, const char * argv[], const char * expected) {
    for (int index = 1; index < argc; index += 1) {
        if (strcmp(argv[index], expected) == 0) {
            return YES;
        }
    }
    return NO;
}

static BOOL writeDisplayID(CGDirectDisplayID displayID, NSString *stateFilePath) {
    NSError *writeError = nil;
    NSString *displayIDString = [NSString stringWithFormat:@"%u\n", displayID];
    if ([displayIDString writeToFile:stateFilePath
                          atomically:YES
                            encoding:NSUTF8StringEncoding
                               error:&writeError]) {
        return YES;
    }
    NSLog(@"Could not write virtual display ID to %@: %@", stateFilePath, writeError);
    return NO;
}

static CGDirectDisplayID findExistingVirtualDisplay(void) {
    uint32_t displayCount = 0;
    if (CGGetOnlineDisplayList(0, NULL, &displayCount) != kCGErrorSuccess || displayCount == 0) {
        return kCGNullDirectDisplay;
    }

    CGDirectDisplayID *displayIDs = calloc(displayCount, sizeof(CGDirectDisplayID));
    if (!displayIDs) {
        return kCGNullDirectDisplay;
    }
    CGDirectDisplayID matchingDisplay = kCGNullDirectDisplay;
    uint32_t returnedCount = 0;
    if (CGGetOnlineDisplayList(displayCount, displayIDs, &returnedCount) == kCGErrorSuccess) {
        for (uint32_t index = 0; index < returnedCount; index += 1) {
            CGDirectDisplayID candidate = displayIDs[index];
            if (CGDisplayVendorNumber(candidate) == kVirtualDisplayVendorID &&
                CGDisplayModelNumber(candidate) == kVirtualDisplayProductID &&
                CGDisplaySerialNumber(candidate) == kVirtualDisplaySerial) {
                if (matchingDisplay != kCGNullDirectDisplay) {
                    matchingDisplay = kCGNullDirectDisplay;
                    break;
                }
                matchingDisplay = candidate;
            }
        }
    }
    free(displayIDs);
    return matchingDisplay;
}

static void logDisplayMode(CGDirectDisplayID displayID, NSString *label) {
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(displayID);
    if (!mode) {
        NSLog(@"[iPad Display] %@ mode is unavailable for display ID %u", label, displayID);
        return;
    }

    NSLog(@"[iPad Display] %@ mode: logical=%zux%zu pixels=%zux%zu refresh=%.2fHz",
          label,
          CGDisplayModeGetWidth(mode),
          CGDisplayModeGetHeight(mode),
          CGDisplayModeGetPixelWidth(mode),
          CGDisplayModeGetPixelHeight(mode),
          CGDisplayModeGetRefreshRate(mode));
    CGDisplayModeRelease(mode);
}

static CGDisplayModeRef copyRequiredHiDPIMode(CGDirectDisplayID displayID) {
    NSDictionary *options = @{
        (__bridge NSString *)kCGDisplayShowDuplicateLowResolutionModes: @YES
    };
    CFArrayRef modes = CGDisplayCopyAllDisplayModes(displayID, (__bridge CFDictionaryRef)options);
    if (!modes) return NULL;

    CGDisplayModeRef requiredMode = NULL;
    for (CFIndex index = 0; index < CFArrayGetCount(modes); index += 1) {
        CGDisplayModeRef mode = (CGDisplayModeRef)CFArrayGetValueAtIndex(modes, index);
        size_t width = CGDisplayModeGetWidth(mode);
        size_t height = CGDisplayModeGetHeight(mode);
        size_t pixelWidth = CGDisplayModeGetPixelWidth(mode);
        size_t pixelHeight = CGDisplayModeGetPixelHeight(mode);

        if (width == kRequiredDisplayWidth || height == kRequiredDisplayHeight ||
            pixelWidth == kRequiredBackingWidth || pixelHeight == kRequiredBackingHeight) {
            NSLog(@"[iPad Display] Available relevant mode: logical=%zux%zu pixels=%zux%zu refresh=%.2fHz",
                  width,
                  height,
                  pixelWidth,
                  pixelHeight,
                  CGDisplayModeGetRefreshRate(mode));
        }
        if (width == kRequiredDisplayWidth && height == kRequiredDisplayHeight &&
            pixelWidth == kRequiredBackingWidth && pixelHeight == kRequiredBackingHeight) {
            requiredMode = CGDisplayModeRetain(mode);
        }
    }
    CFRelease(modes);
    return requiredMode;
}

static BOOL selectRequiredHiDPIMode(CGDirectDisplayID displayID) {
    CGDisplayModeRef mode = copyRequiredHiDPIMode(displayID);
    if (!mode) {
        NSLog(@"[iPad Display] Required 1600x1200 logical / 3200x2400 pixel mode is not available yet");
        return NO;
    }

    CGError result = CGDisplaySetDisplayMode(displayID, mode, NULL);
    CGDisplayModeRelease(mode);
    if (result != kCGErrorSuccess) {
        NSLog(@"[iPad Display] Could not select required HiDPI mode: %d", result);
        return NO;
    }
    return YES;
}

static void selectAndVerifyRequiredHiDPIMode(CGDirectDisplayID displayID, NSUInteger attemptsRemaining) {
    selectRequiredHiDPIMode(displayID);
    logDisplayMode(displayID, @"current");
    if (attemptsRemaining == 0) return;

    // Ventura can restore a saved mode after the virtual display first appears.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        selectAndVerifyRequiredHiDPIMode(displayID, attemptsRemaining - 1);
    });
}

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSString *stateFilePath = stateFilePathFromArguments(argc, argv);
        if (hasArgument(argc, argv, "--write-existing-id")) {
            if (!stateFilePath) {
                NSLog(@"--write-existing-id requires --state-file");
                return 1;
            }
            CGDirectDisplayID existingDisplay = findExistingVirtualDisplay();
            if (existingDisplay == kCGNullDirectDisplay) {
                NSLog(@"Could not identify exactly one existing iPad virtual display");
                return 1;
            }
            return writeDisplayID(existingDisplay, stateFilePath) ? 0 : 1;
        }

        CGVirtualDisplayDescriptor *descriptor =
            [[CGVirtualDisplayDescriptor alloc] init];

        [descriptor setDispatchQueue:dispatch_get_main_queue()];
        descriptor.name = @"iPad 4:3 Display";
        descriptor.maxPixelsWide = kRequiredBackingWidth;
        descriptor.maxPixelsHigh = kRequiredBackingHeight;
        descriptor.sizeInMillimeters = CGSizeMake(197, 148);
        descriptor.serialNum = kVirtualDisplaySerial;
        descriptor.productID = kVirtualDisplayProductID;
        descriptor.vendorID = kVirtualDisplayVendorID;

        CGVirtualDisplay *display =
            [[CGVirtualDisplay alloc] initWithDescriptor:descriptor];

        if (!display) {
            NSLog(@"Could not create virtual display");
            return 1;
        }

        // CGVirtualDisplay selects the initial desktop mode from this order.
        // Keep the alternate modes available, but make the required mode first.
        NSArray *modes = @[
            [[CGVirtualDisplayMode alloc] initWithWidth:1600 height:1200 refreshRate:60],
            [[CGVirtualDisplayMode alloc] initWithWidth:2048 height:1536 refreshRate:60],
            [[CGVirtualDisplayMode alloc] initWithWidth:1440 height:1080 refreshRate:60],
            [[CGVirtualDisplayMode alloc] initWithWidth:1280 height:960 refreshRate:60]
        ];

        CGVirtualDisplaySettings *settings = [[CGVirtualDisplaySettings alloc] init];
        settings.hiDPI = 1;
        settings.modes = modes;

        if (![display applySettings:settings]) {
            NSLog(@"Could not apply display settings");
            return 1;
        }
        if (stateFilePath && !writeDisplayID(display.displayID, stateFilePath)) {
            return 1;
        }

        selectAndVerifyRequiredHiDPIMode(display.displayID, 5);

        NSLog(@"iPad 4:3 virtual display requested at %zux%zu — display ID %u",
              kRequiredDisplayWidth,
              kRequiredDisplayHeight,
              display.displayID);
        [[NSRunLoop currentRunLoop] run];
    }
    return 0;
}
