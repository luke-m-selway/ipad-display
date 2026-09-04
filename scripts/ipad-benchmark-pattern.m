#import <Cocoa/Cocoa.h>
#include <stdlib.h>
#include <string.h>

@interface BenchmarkView : NSView
@property(nonatomic) BOOL whiteSquare;
@property(nonatomic) NSUInteger sequence;
@property(nonatomic) BOOL isReference;
@end

@implementation BenchmarkView

- (void)drawRect:(NSRect)dirtyRect {
    [[NSColor whiteColor] setFill];
    NSRectFill(self.bounds);

    NSRect square = NSMakeRect(30, self.bounds.size.height - 310, 280, 280);
    NSColor *squareColor = self.whiteSquare ? NSColor.whiteColor : NSColor.blackColor;
    [squareColor setFill];
    NSRectFill(square);
    [[NSColor blackColor] setStroke];
    NSFrameRect(square);

    NSDictionary *sequenceAttributes = @{
        NSFontAttributeName: [NSFont monospacedDigitSystemFontOfSize:22 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName: NSColor.blackColor,
    };
    [[NSString stringWithFormat:@"%04lu", (unsigned long)self.sequence]
        drawAtPoint:NSMakePoint(30, self.bounds.size.height - 345)
        withAttributes:sequenceAttributes];

    if (self.isReference) return;

    [@"VP8 capture benchmark — static sharpness pattern"
        drawAtPoint:NSMakePoint(350, self.bounds.size.height - 45)
        withAttributes:@{
            NSFontAttributeName: [NSFont systemFontOfSize:18 weight:NSFontWeightSemibold],
            NSForegroundColorAttributeName: NSColor.blackColor,
        }];
    [@"Normal UI text: Sphinx of black quartz, judge my vow."
        drawAtPoint:NSMakePoint(350, self.bounds.size.height - 82)
        withAttributes:@{
            NSFontAttributeName: [NSFont systemFontOfSize:16],
            NSForegroundColorAttributeName: NSColor.blackColor,
        }];
    [@"Small text: 0123456789 AaEeMmWw Il1|"
        drawAtPoint:NSMakePoint(350, self.bounds.size.height - 110)
        withAttributes:@{
            NSFontAttributeName: [NSFont systemFontOfSize:13],
            NSForegroundColorAttributeName: NSColor.blackColor,
        }];
    [@"Fine text: 0123456789 AaEeMmWw Il1|"
        drawAtPoint:NSMakePoint(350, self.bounds.size.height - 134)
        withAttributes:@{
            NSFontAttributeName: [NSFont systemFontOfSize:11],
            NSForegroundColorAttributeName: NSColor.blackColor,
        }];

    [[NSColor blackColor] setFill];
    for (NSUInteger index = 0; index < 120; index += 1) {
        CGFloat x = 350 + index * 3;
        NSRectFill(NSMakeRect(x, self.bounds.size.height - 170, 1, 26));
    }
    for (NSUInteger index = 0; index < 20; index += 1) {
        CGFloat y = self.bounds.size.height - 215 - index * 3;
        NSRectFill(NSMakeRect(350, y, 360, 1));
    }

    const CGFloat checkerSize = 4;
    NSPoint checkerOrigin = NSMakePoint(350, self.bounds.size.height - 305);
    for (NSUInteger row = 0; row < 24; row += 1) {
        for (NSUInteger column = 0; column < 48; column += 1) {
            NSColor *checkerColor = (row + column) % 2 == 0 ? NSColor.blackColor : NSColor.whiteColor;
            [checkerColor setFill];
            NSRectFill(NSMakeRect(checkerOrigin.x + column * checkerSize,
                                  checkerOrigin.y + row * checkerSize,
                                  checkerSize,
                                  checkerSize));
        }
    }
    [[NSColor blackColor] setStroke];
    NSFrameRect(NSMakeRect(checkerOrigin.x, checkerOrigin.y, 48 * checkerSize, 24 * checkerSize));
}

@end

@interface BenchmarkController : NSObject
@property(nonatomic, strong) BenchmarkView *referenceView;
@property(nonatomic, strong) BenchmarkView *virtualView;
@property(nonatomic) NSUInteger sequence;
@end

@implementation BenchmarkController

- (void)toggle:(NSTimer *)timer {
    self.sequence += 1;
    self.referenceView.sequence = self.sequence;
    self.virtualView.sequence = self.sequence;
    self.referenceView.whiteSquare = !self.referenceView.whiteSquare;
    self.virtualView.whiteSquare = self.referenceView.whiteSquare;
    [self.referenceView setNeedsDisplay:YES];
    [self.virtualView setNeedsDisplay:YES];
}

@end

static NSString *displayIDFileFromArguments(int argc, const char *argv[]) {
    for (int index = 1; index + 1 < argc; index += 1) {
        if (strcmp(argv[index], "--display-id-file") == 0) {
            return [NSString stringWithUTF8String:argv[index + 1]];
        }
    }
    return nil;
}

static NSScreen *screenForDisplayID(NSNumber *displayID) {
    for (NSScreen *screen in NSScreen.screens) {
        NSNumber *candidate = screen.deviceDescription[@"NSScreenNumber"];
        if ([candidate isEqualToNumber:displayID]) return screen;
    }
    return nil;
}

static NSScreen *builtInScreen(void) {
    for (NSScreen *screen in NSScreen.screens) {
        NSNumber *displayID = screen.deviceDescription[@"NSScreenNumber"];
        if (CGDisplayIsBuiltin(displayID.unsignedIntValue)) return screen;
    }
    return NSScreen.mainScreen;
}

static NSWindow *createWindow(NSScreen *screen, NSSize size, BenchmarkView **viewOut, BOOL isReference) {
    NSRect visibleFrame = screen.visibleFrame;
    NSRect frame = NSMakeRect(visibleFrame.origin.x + 40,
                              NSMaxY(visibleFrame) - size.height - 40,
                              size.width,
                              size.height);
    NSWindow *window = [[NSWindow alloc] initWithContentRect:frame
                                                    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                                                      backing:NSBackingStoreBuffered
                                                        defer:NO
                                                       screen:screen];
    window.title = isReference ? @"iPad Benchmark Reference" : @"iPad Benchmark Pattern";
    window.level = NSFloatingWindowLevel;
    BenchmarkView *view = [[BenchmarkView alloc] initWithFrame:NSMakeRect(0, 0, size.width, size.height)];
    view.isReference = isReference;
    view.whiteSquare = NO;
    [window setContentView:view];
    [window makeKeyAndOrderFront:nil];
    *viewOut = view;
    return window;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *displayIDFile = displayIDFileFromArguments(argc, argv);
        if (!displayIDFile) {
            NSLog(@"--display-id-file is required");
            return 1;
        }
        NSString *displayIDText = [NSString stringWithContentsOfFile:displayIDFile
                                                             encoding:NSUTF8StringEncoding
                                                                error:nil];
        NSInteger displayID = displayIDText.integerValue;
        NSScreen *virtualScreen = screenForDisplayID(@(displayID));
        NSScreen *referenceScreen = builtInScreen();
        if (!virtualScreen || !referenceScreen) {
            NSLog(@"Could not find the benchmark displays");
            return 1;
        }

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        BenchmarkController *controller = [[BenchmarkController alloc] init];
        BenchmarkView *referenceView = nil;
        BenchmarkView *virtualView = nil;
        NSWindow *referenceWindow = createWindow(referenceScreen, NSMakeSize(360, 380), &referenceView, YES);
        NSWindow *virtualWindow = createWindow(virtualScreen, NSMakeSize(840, 420), &virtualView, NO);
        controller.referenceView = referenceView;
        controller.virtualView = virtualView;
        (void)referenceWindow;
        (void)virtualWindow;
        NSTimer *timer = [NSTimer scheduledTimerWithTimeInterval:1.0
                                                            target:controller
                                                          selector:@selector(toggle:)
                                                          userInfo:nil
                                                           repeats:YES];
        timer.tolerance = 0;
        [[NSRunLoop currentRunLoop] run];
    }
    return 0;
}
