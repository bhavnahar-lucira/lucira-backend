// ─────────────────────────────────────────────────────────────────────────────
// Seed content for GET /api/settings/store-pages.
//
// Every value below is copied VERBATIM from the storefront constants that used
// to be the only source of store content:
//   • src/components/collections/StoreCollectionBanner.jsx  → STORES_DATA
//   • src/app/(frontend)/collections/[handle]/CollectionPageClient.js
//                                            → STORE_HANDLES, STORE_IMAGES
//   • src/components/home/StoreLocatorSection.jsx           → ALL_STORES
//   • src/app/(frontend)/pages/store-locator/StoreLocatorClient.jsx → ALL_STORES
//   • src/components/common/PopularSearches.jsx             → "Visit our stores:"
//   • src/data/stores.js + src/data/storeGeo.js             → active flags, coords
//
// Until the `store_pages` settings doc is saved once from the dashboard, every
// storefront surface renders exactly as it did before this feature existed.
//
// SERVICE ICONS: the collection banner used /images/store/*.svg while the
// homepage used the Homepage_Store_*.svg files on the Shopify CDN. Those pairs
// are the same artwork (identical path data and fills — only attribute order
// differs), so they are unified here on the CDN copies. Nothing changes
// visually and the dashboard only ever manages one URL per service.
// ─────────────────────────────────────────────────────────────────────────────

const CDN = 'https://cdn.shopify.com/s/files/1/0739/8516/3482/files';

/** The four services every store offers today. Also the default for a new store. */
const DEFAULT_SERVICES = [
  { title: 'Gold Exchange', icon: CDN + '/Homepage_Store_gold-exchange.svg' },
  { title: 'Vault of Dreams', icon: CDN + '/Homepage_Store_vault.svg' },
  { title: 'Carat Tester', icon: CDN + '/Homepage_Store_carat-tester.svg' },
  { title: 'Jewelry Cleaning', icon: CDN + '/Homepage_Store_jewelry-cleaning.svg' },
];

/** Facility chips used across the existing stores — offered as one-tap suggestions. */
const FACILITY_SUGGESTIONS = [
  'Kids Area',
  'Design Your Ring',
  'Open Weekends',
  'Open on Weekends',
  'Banks Nearby',
  'Parking Available',
  'Parking Availability',
  'Exclusive Offers',
  'Daily Offers',
  'Piercing',
];

const HOURS_10_TO_10 = {
  weekday: { open: '10:30', close: '22:00' },
  weekend: { open: '10:30', close: '22:00' },
};

const STORE_PAGE_DEFAULTS = {
  serviceCatalog: DEFAULT_SERVICES,
  facilitySuggestions: FACILITY_SUGGESTIONS,
  stores: [
    // ── Malad / Head Office ───────────────────────────────────────────────
    // Never had a collection-page hero (STORES_DATA had no "malad" key) and is
    // absent from the homepage carousel — it only appears on the store locator.
    {
      id: 'st_malad',
      handle: 'malad',
      city: 'Malad',
      name: 'Head Office',
      rating: 5.0,
      status: 'auto',
      published: true,
      hours: HOURS_10_TO_10,
      hoursLabel: '',
      email: 'care@lucirajewelry.com',
      phone: '+919004436052',
      address: 'Office 1402-2, DLH Park, 14th Floor, SV Rd, Mumbai, Maharashtra 400062',
      links: {
        map: 'https://www.google.com/maps/place/Lucira+Jewelry+%7C+Jewellery+Store+in+Mumbai/data=!4m2!3m1!1s0x0:0x268fe0bb8a89f9bb?sa=X&ved=1t:2428&ictx=111',
        call: 'tel:+919004436052',
        appointment: '',
        designs: '/collections/malad',
        whatsapp: 'https://api.whatsapp.com/send?phone=918976740895&text=Hi%2C%20I%E2%80%99d%20like%20to%20visit%20the%20Head%20Office%20and%20explore%20the%20designs.',
        directions: '/collections/malad',
      },
      facilities: [],
      services: DEFAULT_SERVICES,
      images: {
        collection: [CDN + '/store_4ee3a4f7-ce43-4373-9830-67ab62a8a2e6.jpg'],
        homepage: '',
        locator: 'https://luciraonline.myshopify.com/cdn/shop/files/Lucira_contact_us_grid_900x.png?v=1757660196',
      },
      geo: { lat: 19.1743803, lng: 72.844728 },
      visitable: false,
      shopifyLocationId: '',
      surfaces: {
        collectionBanner: false,
        homepage: false,
        productPage: false,
        storeLocator: true,
        footerLink: false,
        experienceStores: true,
      },
      experienceLabel: 'Head Office',
      footerLinkLabel: '',
      sort: 0,
      sortOverrides: { homepage: null, storeLocator: 0, footerLink: null, experienceStores: 0 },
    },

    // ── Pune ──────────────────────────────────────────────────────────────
    {
      id: 'st_pune',
      handle: 'pune-store',
      city: 'Pune',
      name: 'Pune Lucira Store',
      rating: 4.8,
      status: 'auto',
      published: true,
      hours: HOURS_10_TO_10,
      hoursLabel: '',
      email: 'lcspnqjmr@lucirajewelry.com',
      phone: '+91 8433667236',
      address: 'Shop no. 3,4, Balgandharv Chowk, Sai Square, 5 & 6, Jangali Maharaj Rd, Pune, Maharashtra 411005',
      links: {
        map: 'https://www.google.com/maps/place/Lucira+Jewelry+%7C+Jewellery+Store+in+JM+Road+Pune/@18.5233058,73.8452878,17z/data=!3m1!4b1!4m6!3m5!1s0x3bc2c1929b1639f7:0x7d0f5ff74de52a8d!8m2!3d18.5233007!4d73.8478627!16s%2Fg%2F11ylpdz9dm?coh=277534&entry=tts&g_ep=EgoyMDI1MTIwOS4wIPu8ASoKLDEwMDc5MjA3MUgBUAM%3D&skid=daaa869f-0b7a-43cd-bcdf-3c35f206de47',
        call: 'tel:+918433667236',
        appointment: 'https://wa.me/919004435760?text=Hi,%20I%20would%20like%20to%20book%20an%20appointment%20at%20the%20Pune%20Store',
        designs: '/collections/pune-store',
        whatsapp: 'https://api.whatsapp.com/send/?phone=918976740895&text=Hi%2C+I%E2%80%99d+like+to+visit+the+Pune+Lucira+store+and+explore+the+designs.&type=phone_number&app_absent=0',
        directions: 'https://www.lucirajewelry.com/collections/pune-store',
      },
      facilities: ['Kids Area', 'Design Your Ring', 'Open Weekends', 'Banks Nearby', 'Parking Available', 'Exclusive Offers', 'Piercing'],
      services: DEFAULT_SERVICES,
      images: {
        collection: [CDN + '/Pune.jpg'],
        homepage: CDN + '/Homepage_Store_Pune.jpg',
        locator: 'https://luciraonline.myshopify.com/cdn/shop/files/Store-PLP-2_900x.jpg?v=1765807125',
      },
      geo: { lat: 18.5233666, lng: 73.8499211 },
      visitable: true,
      shopifyLocationId: '',
      surfaces: {
        collectionBanner: true,
        homepage: true,
        productPage: true,
        storeLocator: true,
        footerLink: true,
        experienceStores: true,
      },
      experienceLabel: 'Pune Store',
      footerLinkLabel: 'Lab Grown Diamond Jewelry in Pune',
      sort: 1,
      sortOverrides: { homepage: 0, storeLocator: 3, footerLink: 0, experienceStores: 3 },
    },

    // ── Chembur ───────────────────────────────────────────────────────────
    {
      id: 'st_chembur',
      handle: 'chembur-store',
      city: 'Chembur',
      name: 'Chembur Lucira Store',
      rating: 4.7,
      status: 'auto',
      published: true,
      hours: HOURS_10_TO_10,
      hoursLabel: '',
      email: 'lcsbomchb@lucirajewelry.com',
      phone: '+91 9004402038',
      address: 'Shop No. 3 Ground Floor, 487, Geraldine CHS LTD, Central Ave Rd, Chembur, Mumbai, Maharashtra 400071',
      links: {
        map: 'https://www.google.com/maps/place/Lucira+Jewelry+%7C+Jewellery+Store+in+Chembur+Mumbai/@19.0576005,72.898121,17z/data=!3m1!4b1!4m6!3m5!1s0x3be7c782f7511b79:0xaa877f3bbd754bfc!8m2!3d19.0575954!4d72.9006959!16s%2Fg%2F11xtgz09vw?coh=277534&entry=tts&g_ep=EgoyMDI1MTIwOS4wIPu8ASoKLDEwMDc5MjA3MUgBUAM%3D&skid=24407d76-c38a-4e0f-9635-b44cee4c4b31',
        call: 'tel:+919004402038',
        appointment: 'https://wa.me/919004435760?text=Hi,%20I%20would%20like%20to%20book%20an%20appointment%20at%20the%20Chembur%20Store',
        designs: '/collections/chembur-store',
        whatsapp: 'https://api.whatsapp.com/send/?phone=918976740895&text=Hi%2C+I%E2%80%99d+like+to+visit+the+Chembur+Lucira+store+and+explore+the+designs.&type=phone_number&app_absent=0',
        directions: '/collections/chembur-store',
      },
      facilities: ['Open on Weekends', 'Banks Nearby', 'Parking Availability', 'Daily Offers', 'Piercing'],
      services: DEFAULT_SERVICES,
      images: {
        collection: [CDN + '/Chembur_73ce3ac6-7515-473d-a2dd-2385fd065eaa.jpg'],
        homepage: CDN + '/Homepage_Store_Chembur.jpg',
        locator: 'https://luciraonline.myshopify.com/cdn/shop/files/Store-Collection-Banner-2_900x.jpg?v=1760699342',
      },
      geo: { lat: 19.0579383, lng: 72.900486 },
      visitable: true,
      shopifyLocationId: '',
      surfaces: {
        collectionBanner: true,
        homepage: true,
        productPage: true,
        storeLocator: true,
        footerLink: true,
        experienceStores: true,
      },
      experienceLabel: 'Chembur Store',
      footerLinkLabel: 'Lab Grown Diamond Jewelry in Chembur',
      sort: 2,
      sortOverrides: { homepage: 1, storeLocator: 2, footerLink: 3, experienceStores: 2 },
    },

    // ── Borivali ──────────────────────────────────────────────────────────
    {
      id: 'st_borivali',
      handle: 'sky-city-borivali-store',
      city: 'Borivali',
      name: 'Borivali Lucira Store',
      rating: 4.9,
      status: 'auto',
      published: true,
      hours: {
        weekday: { open: '10:30', close: '21:30' },
        weekend: { open: '10:30', close: '21:30' },
      },
      hoursLabel: '',
      email: 'lcmbombor@lucirajewelry.com',
      phone: '+918433667238',
      address: 'Sky City Mall, S-40, 2nd Floor, Western Express Hwy, Borivali East, Mumbai - 400066',
      links: {
        map: 'https://www.google.com/maps/place/Lucira+Jewelry+%7C+Jewelry+Store+in+Borivali+Mumbai/@19.2226624,72.8617494,621m/data=!3m2!1e3!4b1!4m6!3m5!1s0x3be7b13efc944429:0x8e0b915ac78ac1!8m2!3d19.2226574!4d72.8643243!16s%2Fg%2F11ytqp4xsk?hl=en&entry=ttu&g_ep=EgoyMDI1MTIwOS4wIKXMDSoASAFQAw%3D%3D',
        call: 'tel:+918433667238',
        appointment: 'https://wa.me/919004435760?text=Hi,%20I%20would%20like%20to%20book%20an%20appointment%20at%20the%20Borivali%20Store',
        designs: '/collections/sky-city-borivali-store',
        whatsapp: 'https://api.whatsapp.com/send/?phone=918976740895&text=Hi%2C+I%E2%80%99d+like+to+visit+the+Borivali+Lucira+store+and+explore+the+designs.&type=phone_number&app_absent=0',
        directions: '/collections/sky-city-borivali-store',
      },
      facilities: ['Design Your Ring', 'Open Weekends', 'Parking Available', 'Exclusive Offers', 'Piercing'],
      services: DEFAULT_SERVICES,
      images: {
        collection: ['/images/store/Borivali.jpg'],
        homepage: CDN + '/Homepage_Store_Borivali.jpg',
        locator: 'https://luciraonline.myshopify.com/cdn/shop/files/Store-Collection-Banner3_jpg_900x.jpg?v=1769237134',
      },
      geo: { lat: 19.2232556, lng: 72.8640139 },
      visitable: true,
      shopifyLocationId: '',
      surfaces: {
        collectionBanner: true,
        homepage: true,
        productPage: true,
        storeLocator: true,
        footerLink: true,
        experienceStores: true,
      },
      experienceLabel: 'Borivali Store',
      footerLinkLabel: 'Lab Grown Diamond Jewelry in Borivali',
      sort: 3,
      sortOverrides: { homepage: 2, storeLocator: 1, footerLink: 2, experienceStores: 1 },
    },

    // ── Noida ─────────────────────────────────────────────────────────────
    {
      id: 'st_noida',
      handle: 'noida-store',
      city: 'Noida',
      name: 'Noida Lucira Store',
      rating: 4.9,
      status: 'auto',
      published: true,
      hours: HOURS_10_TO_10,
      hoursLabel: '',
      email: 'lcnois18@lucirajewelry.com',
      phone: '+91 8657392887',
      address: 'SCO-17, Wave One Courtyard, Sector 18, Gautam Buddha Nagar, Noida, Uttar Pradesh 201301',
      links: {
        map: 'https://maps.google.com/?q=Noida+Lucira+Store',
        call: 'tel:+918657392887',
        appointment: 'https://wa.me/919004435760?text=Hi,%20I%20would%20like%20to%20book%20an%20appointment%20at%20the%20Noida%20Store',
        designs: '/collections/noida-store',
        whatsapp: 'https://api.whatsapp.com/send?phone=918976740895&text=Hi%2C%20I%E2%80%99d%20like%20to%20visit%20the%20Noida%20Store%20and%20explore%20the%20designs.',
        directions: 'https://www.lucirajewelry.com/collections/noida-store',
      },
      facilities: ['Kids Area', 'Design Your Ring', 'Open Weekends', 'Banks Nearby', 'Parking Available', 'Exclusive Offers', 'Piercing'],
      services: DEFAULT_SERVICES,
      images: {
        collection: [CDN + '/Noida.jpg'],
        homepage: CDN + '/Homepage_Store_Noida.jpg',
        locator: 'https://luciraonline.myshopify.com/cdn/shop/files/Noida_Store_1920_823_jpg_1920x823_crop_center.jpg?v=1776422892',
      },
      geo: { lat: 28.569958, lng: 77.3233777 },
      visitable: true,
      shopifyLocationId: '',
      surfaces: {
        collectionBanner: true,
        homepage: true,
        productPage: true,
        storeLocator: true,
        footerLink: true,
        experienceStores: true,
      },
      experienceLabel: 'Noida Store',
      footerLinkLabel: 'Lab Grown Diamond Jewelry in Noida',
      sort: 4,
      sortOverrides: { homepage: 3, storeLocator: 4, footerLink: 1, experienceStores: 4 },
    },

    // ── Paschim Vihar ─────────────────────────────────────────────────────
    {
      id: 'st_paschim_vihar',
      handle: 'paschim-vihar',
      city: 'Paschim Vihar',
      name: 'Paschim Vihar Lucira Store',
      rating: 4.7,
      status: 'auto',
      published: true,
      hours: HOURS_10_TO_10,
      hoursLabel: '',
      email: 'lcsdelpvh@lucirajewelry.com',
      phone: '+91 7208007494',
      address: 'B-8, Shubham Enclave, Reserve Bank Enclave, Paschim Vihar, New Delhi, Delhi, 110063',
      links: {
        map: 'https://www.google.com/maps/place/Lucira+Jewelry+%7C+Jewellery+Store+in+Paschim+Vihar/@28.6690057,77.0913898,17z/data=!3m1!4b1!4m6!3m5!1s0x390d05249d584873:0xc8f976a13ee1921d!8m2!3d28.669001!4d77.0939647!16s%2Fg%2F11nq100hwp?entry=ttu&g_ep=EgoyMDI2MDYyNC4wIKXMDSoASAFQAw%3D%3D',
        call: 'tel:+917208007494',
        appointment: 'https://wa.me/917208007494?text=Hi,%20I%20would%20like%20to%20book%20an%20appointment%20at%20the%20Paschim%20Vihar%20Store',
        designs: '/collections/paschim-vihar',
        whatsapp: 'https://api.whatsapp.com/send/?phone=918976740895&text=Hi%2C+I%E2%80%99d+like+to+visit+the+Paschim+Vihar+Lucira+store+and+explore+the+designs.&type=phone_number&app_absent=0',
        directions: 'https://www.lucirajewelry.com/collections/paschim-vihar',
      },
      facilities: ['Open on Weekends', 'Banks Nearby', 'Parking Availability', 'Daily Offers', 'Piercing'],
      services: DEFAULT_SERVICES,
      images: {
        collection: [
          CDN + '/Paschim_vihar_store_a.png?v=1784362982',
          CDN + '/Paschim_vihar_store_a.png?v=1784362982',
        ],
        homepage: CDN + '/Paschim_vihar_store_a.png?v=1784362982',
        locator: CDN + '/Paschim_vihar_store_a.png?v=1784362982',
      },
      geo: { lat: 28.668197, lng: 77.0945777 },
      visitable: true,
      shopifyLocationId: '',
      surfaces: {
        collectionBanner: true,
        homepage: true,
        productPage: true,
        storeLocator: true,
        footerLink: true,
        experienceStores: true,
      },
      experienceLabel: 'Paschim Vihar Store',
      footerLinkLabel: 'Lab Grown Diamond Jewelry in Paschim Vihar',
      sort: 5,
      sortOverrides: { homepage: 4, storeLocator: 5, footerLink: 5, experienceStores: 5 },
    },

    // ── Lajpat Nagar ──────────────────────────────────────────────────────
    // The homepage/collection surfaces never set a rating for this store, so the
    // star block is hidden there; the locator card shows no rating either.
    {
      id: 'st_lajpat_nagar',
      handle: 'lajpat-nagar-store',
      city: 'Lajpat Nagar',
      name: 'Lajpat Nagar Lucira Store',
      rating: null,
      status: 'auto',
      published: true,
      hours: HOURS_10_TO_10,
      hoursLabel: '',
      email: 'LCSDELLJN@lucirajewelry.com',
      phone: '+91 7208007495',
      address: 'A-59A, Ground Floor, Left Side, Lajpat Nagar-2, New Delhi 110024',
      links: {
        map: 'https://www.google.com/maps/search/Lucira+Jewelry+Lajpat+Nagar+New+Delhi',
        call: 'tel:+917208007495',
        appointment: 'https://wa.me/917208007495?text=Hi,%20I%20would%20like%20to%20book%20an%20appointment%20at%20the%20Lajpat%20Nagar%20Store',
        designs: '/collections/lajpat-nagar-store',
        whatsapp: 'https://api.whatsapp.com/send/?phone=918976740895&text=Hi%2C+I%E2%80%99d+like+to+visit+the+Lajpat+Nagar+Lucira+store+and+explore+the+designs.&type=phone_number&app_absent=0',
        directions: 'https://www.lucirajewelry.com/collections/lajpat-nagar-store',
      },
      facilities: ['Open on Weekends', 'Banks Nearby', 'Parking Availability', 'Daily Offers', 'Piercing'],
      services: DEFAULT_SERVICES,
      images: {
        // STORE_IMAGES in CollectionPageClient overrode STORES_DATA for this one,
        // so the collection hero has always used the 1800x1350 crop.
        collection: [CDN + '/1800_x_1350_Noida_Store_Image_jpg.jpg?v=1776425633'],
        homepage: 'https://luciraonline.myshopify.com/cdn/shop/files/Noida_Store_1920_823_jpg_1920x823_crop_center.jpg?v=1776422892',
        locator: 'https://luciraonline.myshopify.com/cdn/shop/files/Noida_Store_1920_823_jpg_1920x823_crop_center.jpg?v=1776422892',
      },
      geo: { lat: 28.5692718, lng: 77.2441075 },
      visitable: true,
      shopifyLocationId: '',
      surfaces: {
        collectionBanner: true,
        homepage: true,
        productPage: true,
        storeLocator: true,
        footerLink: true,
        experienceStores: true,
      },
      experienceLabel: 'Lajpat Nagar Store',
      footerLinkLabel: 'Lab Grown Diamond Jewelry in Lajpat Nagar',
      sort: 6,
      sortOverrides: { homepage: 5, storeLocator: 6, footerLink: 6, experienceStores: 6 },
    },
  ],
};

module.exports = { STORE_PAGE_DEFAULTS, DEFAULT_SERVICES, FACILITY_SUGGESTIONS };
