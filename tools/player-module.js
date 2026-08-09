// Replacement body for Turbopack module 50431 (the shared hero video player).
//
// The original set a single 1080p `src` with no poster, no renditions, and
// faded the element in from opacity-0 -- which is why the hero was a black box
// until enough of a 35 MB file had buffered. This version keeps the same
// exports, imports, shuffle-and-rotate behaviour and scroll chevron, and adds:
//   - a poster frame so the hero paints immediately
//   - per-breakpoint + per-codec rendition selection (done in JS, because
//     browsers do NOT honour <source media> inside <video>)
//   - muted set as a property on the node itself before any play() attempt
//   - preload="none" with the fetch deferred a frame past first paint
//   - IntersectionObserver gating so offscreen heroes never fetch, and pause
//   - a still-poster fallback for save-data / 2g / prefers-reduced-motion
//
// __VIDEO_MANIFEST__ is substituted at build time by tools/build.mjs.
e => {
  "use strict";
  e.s(["default", () => Player]);
  var RT = e.i(43476),
    React = e.i(71645);
  var jsx = RT.jsx,
    jsxs = RT.jsxs;

  var MANIFEST = __VIDEO_MANIFEST__;

  function shuffle(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  // Declaring the exact codec string matters: a browser that supports the WebM
  // container but not AV1 would otherwise accept the file and then fail.
  var av1Support = null;
  function supportsAv1() {
    if (av1Support !== null) return av1Support;
    av1Support = false;
    try {
      var probe = document.createElement("video");
      av1Support =
        probe.canPlayType('video/webm; codecs="av01.0.08M.08"') === "probably";
    } catch (_) {}
    return av1Support;
  }

  function prefersStill() {
    try {
      if (
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return true;
      var c = navigator.connection;
      if (c) {
        if (c.saveData === true) return true;
        if (/^(slow-2g|2g)$/.test(String(c.effectiveType || ""))) return true;
      }
    } catch (_) {}
    return false;
  }

  var NARROW = "(max-width: 768px)";

  // "Wifi" in practice means a wide screen on a connection that is not
  // self-reporting as constrained. Safari and Firefox expose no
  // navigator.connection at all, so absence is treated as fast -- a desktop
  // browser is the overwhelmingly likely case, and the capped rendition is
  // always there as the fallback if that guess is wrong.
  function fastLink() {
    try {
      var c = navigator.connection;
      if (!c) return true;
      if (c.saveData === true) return false;
      var et = String(c.effectiveType || "");
      if (et && et !== "4g") return false;
      if (typeof c.downlink === "number" && c.downlink > 0 && c.downlink < 2) return false;
    } catch (_) {}
    return true;
  }

  function Player(props) {
    var videos = props.videos;
    var onScrollNextAction = props.onScrollNextAction;

    var videoRef = React.useRef(null);
    var sectionRef = React.useRef(null);

    var s0 = React.useState([]),
      order = s0[0],
      setOrder = s0[1];
    var s1 = React.useState(0),
      idx = s1[0],
      setIdx = s1[1];
    var s2 = React.useState(0),
      tick = s2[0],
      setTick = s2[1];
    var s3 = React.useState(false),
      still = s3[0],
      setStill = s3[1];
    var s4 = React.useState(false),
      narrow = s4[0],
      setNarrow = s4[1];
    var s5 = React.useState(false),
      near = s5[0],
      setNear = s5[1];
    var s6 = React.useState(true),
      fast = s6[0],
      setFast = s6[1];

    React.useEffect(
      function () {
        setOrder(shuffle(videos));
        setIdx(0);
      },
      [videos],
    );

    React.useEffect(function () {
      setStill(prefersStill());
      setFast(fastLink());
      try {
        var mq = window.matchMedia(NARROW);
        setNarrow(mq.matches);
        var onChange = function () {
          setNarrow(mq.matches);
        };
        if (mq.addEventListener) mq.addEventListener("change", onChange);
        else mq.addListener(onChange);
        return function () {
          if (mq.removeEventListener) mq.removeEventListener("change", onChange);
          else mq.removeListener(onChange);
        };
      } catch (_) {}
    }, []);

    React.useEffect(function () {
      var el = sectionRef.current;
      if (!el) return;
      if (typeof IntersectionObserver === "undefined") {
        setNear(true);
        return;
      }
      var io = new IntersectionObserver(
        function (entries) {
          for (var i = 0; i < entries.length; i++) setNear(entries[i].isIntersecting);
        },
        { rootMargin: "200px 0px" },
      );
      io.observe(el);
      return function () {
        io.disconnect();
      };
    }, []);

    var current = order[idx];
    var entry = current ? MANIFEST[current] : null;
    var poster = entry ? entry.poster || "" : "";
    var lqip = entry ? entry.lqip || "" : "";
    var src = "";
    if (entry) {
      var av1 = supportsAv1();
      if (narrow) {
        src = (av1 && entry.mobileAv1) || entry.mobile;
      } else if (fast && entry.high) {
        // Original, un-recompressed 1080p. AV1 is skipped here on purpose:
        // its whole point was saving bytes, and this tier is chosen when
        // fidelity matters more than transfer size.
        src = entry.high;
      } else {
        src = (av1 && entry.desktopAv1) || entry.desktop;
      }
    }

    React.useEffect(
      function () {
        var v = videoRef.current;
        if (!v || still || !src) return;
        v.muted = true;
        if (!near) {
          try {
            v.pause();
          } catch (_) {}
          return;
        }
        // One frame of delay lets the poster paint and keeps the video from
        // racing the page's images for the first slice of bandwidth.
        var raf = requestAnimationFrame(function () {
          try {
            v.load();
            var p = v.play();
            if (p && p.catch) p.catch(function () {});
          } catch (_) {}
        });
        return function () {
          cancelAnimationFrame(raf);
        };
      },
      [src, near, still, tick],
    );

    function advance() {
      setTick(function (n) {
        return n + 1;
      });
      if (!order.length) return;
      if (idx >= order.length - 1) {
        setOrder(shuffle(videos));
        setIdx(0);
        return;
      }
      setIdx(function (i) {
        return i + 1;
      });
    }

    var mediaClass = "absolute inset-0 h-full w-full object-cover";
    var media = null;

    if (still && poster) {
      media = jsx("img", {
        src: poster,
        alt: "",
        className: mediaClass,
        decoding: "async",
        fetchPriority: "high",
      });
    } else if (src) {
      media = jsx("video", {
        key: src + "#" + tick,
        // Setting muted on the node as it is created is the reliable half of
        // the iOS autoplay fix; the `muted` prop below is the other half.
        ref: function (node) {
          videoRef.current = node;
          if (node) node.muted = true;
        },
        src: src,
        poster: poster,
        autoPlay: true,
        muted: true,
        playsInline: true,
        preload: "none",
        disablePictureInPicture: true,
        onEnded: advance,
        className: mediaClass,
      });
    }

    return jsxs("section", {
      ref: sectionRef,
      className: "relative h-screen w-full overflow-hidden bg-black",
      children: [
        // Inline blurred frame: paints with the HTML, so a slow or flaky
        // connection shows the scene instead of a black rectangle while the
        // poster and then the video arrive on top of it.
        jsx("div", {
          className: "absolute inset-0 bg-black",
          style: lqip
            ? {
                backgroundImage: 'url("' + lqip + '")',
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : undefined,
        }),
        media,
        jsxs("div", {
          onClick: onScrollNextAction,
          role: "button",
          tabIndex: 0,
          "aria-label": "Scroll to next section",
          className:
            "absolute bottom-20 xl:bottom-6 left-1/2 z-10 -translate-x-1/2 cursor-pointer",
          onKeyDown: function (ev) {
            if (ev.key === "Enter" || ev.key === " ") onScrollNextAction();
          },
          children: [
            jsxs("svg", {
              width: "44",
              height: "22",
              viewBox: "0 0 44 22",
              fill: "none",
              xmlns: "http://www.w3.org/2000/svg",
              className: "hidden xl:block",
              children: [
                jsx("line", { x1: "8.30966", y1: "6.5419", x2: "22.7235", y2: "20.9557", stroke: "white", strokeWidth: "2.5" }),
                jsx("line", { x1: "20.956", y1: "20.956", x2: "35.3698", y2: "6.54217", stroke: "white", strokeWidth: "2.5" }),
              ],
            }),
            jsxs("svg", {
              width: "44",
              height: "22",
              viewBox: "0 0 44 22",
              fill: "none",
              xmlns: "http://www.w3.org/2000/svg",
              className: "hidden md:block xl:hidden",
              children: [
                jsx("line", { x1: "8.35233", y1: "6.49923", x2: "22.7661", y2: "20.913", stroke: "white", strokeWidth: "2.62069" }),
                jsx("line", { x1: "20.9133", y1: "20.9133", x2: "35.3271", y2: "6.4995", stroke: "white", strokeWidth: "2.62069" }),
              ],
            }),
            jsxs("svg", {
              width: "19",
              height: "17",
              viewBox: "0 0 19 17",
              fill: "none",
              xmlns: "http://www.w3.org/2000/svg",
              className: "block md:hidden",
              children: [
                jsx("line", { x1: "0.707107", y1: "5.07317", x2: "9.70702", y2: "14.0731", stroke: "white", strokeWidth: "2" }),
                jsx("line", { x1: "8.29289", y1: "14.0732", x2: "17.2928", y2: "5.07325", stroke: "white", strokeWidth: "2" }),
              ],
            }),
          ],
        }),
      ],
    });
  }
}
