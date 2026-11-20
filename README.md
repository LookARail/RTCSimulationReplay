# RTC Schematic Replay

A browser-based replay of RTC simulation history on the modeled track schematic.

Select a folder containing matching `.NODE`, `.LINK`, `.HISTORY`, and `.ROUTE` files, or choose the four files individually. The network and internal node mapping are derived from those files, and HISTORY records are checked against ROUTE before replay. Model files are processed locally in the browser and are not uploaded.

Train positions between recorded nodes are interpolated. The replay can include warm-up and cool-down runs. The application is static and can be hosted from the repository root on GitHub Pages.
