/*
 This script fetches new house listings from DuProprio's website, based on the provided search URL
*/

const config = require('./config.json');
const path = require('path');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const Email = require('email-templates');
const fs = require('fs')
const args = require('minimist')(process.argv.slice(2))
let savedListings = require('./listings.json');

let verboseMode = typeof args.v != 'undefined';
let extraVerboseMode = typeof args.vv != 'undefined';
let status = 'Just started';
let browser, page;

(async () => {
    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({ DNT: "1" });
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        // Scan DuProprio's listings for the specified search URL
        const duProprioListings = await scanDuproprioListings();
        const centrisListings = await scanCentrisListings();
        const suttonListings = await scanSuttonListings();
        const scannedListings = Object.assign(duProprioListings, centrisListings, suttonListings);
        const newListings = {};

        // Check which of those records are new, and discard the rest
        for (const listing of Object.values(scannedListings)) {
            if (typeof savedListings[listing.id] != 'undefined') {
                continue;
            }

            newListings[listing.id] = listing;
            savedListings[listing.id] = listing;
        }

        verbose(`Finished scanning all websites: ${Object.keys(scannedListings).length} listings found, ${Object.keys(newListings).length} are new.`);

        // If any new listing were found...
        if (Object.keys(newListings).length) {
            // Send the new listings by email
            await sendEmailNotification(newListings);

            // Save scanned listings on disk
            await new Promise((resolve) => {
                fs.writeFile(path.join(__dirname, 'listings.json'), JSON.stringify(savedListings, null, 4), 'utf8', resolve);
            });
        }

    } catch (e) {
        await endWithError('stack' in e ? e.stack : e);
    }

    await browser.close();
})();

async function scanDuproprioListings() {
    const todaysDate = formatDate();
    let isOnLastPage = false;
    let pageNumber = 1;
    let listings = {};

    status = "Opening DuProprio's website";
    verbose("Opening DuProprio's website...");

    try {
        await page.goto(config.duproprio.url, { waitUntil: "networkidle2", timeout: 60000 });

        verbose("Starting to scan for listings...");
        do {
            verbose(`Scanning page ${pageNumber}...`);

            status = "Looking for DuProprio listing items";
            const listingNodes = await page.$$('.search-results-listings-list__item:not(.is-sold)');

            for (const listingNode of listingNodes) {
                let listingId = await getNodeAttribute(listingNode, 'id');

                if (!/listing-[0-9]+/.test(listingId)) {
                    continue;
                }

                listingId = listingId.split('-')[1];
                status = "Processing DuProprio listing item " + listingId;

                listings['duproprio-' + listingId] = await page.evaluate((node, todaysDate) => {
                    const cityNode = node.querySelector('.search-results-listings-list__item-description__city-wrap');
                    const addressNode = node.querySelector('.search-results-listings-list__item-description__address');
                    const descriptionNode = node.querySelector('.search-results-listings-list__item-description__type-and-intro');

                    return {
                        id: 'duproprio-' + node.id.split('-')[1],
                        price: parseInt(node.querySelector('.search-results-listings-list__item-description__price').textContent.replace(/[^0-9]/g, '')),
                        city: cityNode ? cityNode.textContent.trim() : null,
                        address: addressNode ? addressNode.textContent.trim() : null,
                        description: descriptionNode ? descriptionNode.textContent.trim() : null,
                        imageUrl: node.querySelector(`img[ref="${node.id}"]`).getAttribute('src'),
                        url: node.querySelector('a[property="significantLink"]').href,
                        dateScanned: todaysDate,
                        source: 'DuProprio',
                    }
                }, listingNode, todaysDate);
            }

            isOnLastPage = !!(await page.$('.pagination__list .pagination__item.pagination__item--active:last-child'));

            if (!isOnLastPage) {
                pageNumber += 1;
                status = "Going to next page on DuPropio";
                const nextPageLink = await page.$('.pagination__list .pagination__item.pagination__item--active + .pagination__item');
                const [response] = await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
                    nextPageLink.click(),
                ]);
            }

        } while (!isOnLastPage);

        status = "Finished scanning DuProprio";
        verbose(`Finished scanning DuProprio: total of ${Object.keys(listings).length} listings found.`);
    } catch (e) {
        verbose(`An error occured while scanning DuProprio: ${e.message}`);
    }

    return listings;
}

async function scanSuttonListings() {
    const todaysDate = formatDate();
    let isOnLastPage = false;
    let pageNumber = 1;
    let listings = {};

    status = "Opening Sutton's website";
    verbose("Opening Sutton's website...");

    try {
        await page.goto(config.sutton.url, { waitUntil: "networkidle2", timeout: 60000 });

        verbose("Starting to scan for listings...");
        do {
            verbose(`Scanning page ${pageNumber}...`);

            status = "Looking for Sutton listing items";
            const pageListings = await page.evaluate((todaysDate) => {
                const listings = {};

                for (listingNode of document.querySelectorAll('li[data-inscription-id]')) {
                    if (listingNode.querySelector('.vendu')) {
                        continue;
                    }

                    const detailsLinkNode = listingNode.querySelector('.divInscriptionInfo h2 a');
                    const listingId = listingNode.getAttribute('data-inscription-id');
                    const addressNode = listingNode.querySelector('.divInfoCompact address');
                    const cityNode = listingNode.querySelector('.divInscriptionInfo h2 + p > span:first-child');
                    const imageUrl = listingNode.querySelector('.divInscriptionPhoto.compact img').src;
                    const price = parseInt(listingNode.getAttribute('data-prix'));

                    listings['sutton-' + listingId] = {
                        id: 'sutton-' + listingId,
                        price: price,
                        city: cityNode ? cityNode.textContent.trim() : null,
                        address: addressNode ? addressNode.textContent.trim() : null,
                        description: detailsLinkNode.textContent.split(' - ')[0].trim(),
                        imageUrl: imageUrl,
                        url: detailsLinkNode.href,
                        dateScanned: todaysDate,
                        source: 'Sutton',
                    }
                }

                return listings;
            }, todaysDate);

            listings = Object.assign(listings, pageListings);

            isOnLastPage = !!(await page.$('.divControleListe .pagesuivante.hidden'));

            if (!isOnLastPage) {
                pageNumber += 1;
                status = "Going to next page on Sutton";
                const nextPageLink = await page.$('.divControleListe .pagesuivante');
                const [response] = await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
                    nextPageLink.click(),
                ]);
                await delay(500);
            }

        } while (!isOnLastPage);

        status = "Finished scanning Sutton";
        verbose(`Finished scanning Sutton: total of ${Object.keys(listings).length} listings found.`);
    } catch (e) {
        verbose(`An error occured while scanning Sutton: ${e.message}`);
    }

    return listings;
}

async function scanCentrisListings() {
    const todaysDate = formatDate();
    let scannedListings = {};
    let isOnLastPage = false;

    status = "Opening Centris's website";
    verbose("Opening Centris's website...");
    try {
        await page.goto(config.centris.url, { waitUntil: "networkidle2", timeout: 60000 });

        scannedListings = await page.evaluate(async (minPrice, maxPrice, todaysDate) => {
            const listings = {};
            let pageNumber = 1;

            while (document.querySelector('.pager-bottom .pager .next:not(.inactive) a')) {
                if (pageNumber > 1) {
                    const nextPageLink = document.querySelector('.pager-bottom .pager .next:not(.inactive) a');
                    if (nextPageLink) {
                        nextPageLink.click();
                    }

                    await new Promise(function(resolve) {
                        setTimeout(resolve, 1500)
                    });
                }

                for (listingNode of document.querySelectorAll('[data-id="templateThumbnailItem"][itemtype="http://schema.org/Product"]')) {
                    const detailsLinkNode = listingNode.querySelector('a.a-more-detail');
                    const listingId = detailsLinkNode.getAttribute('data-mlsnumber');
                    const addressNode = listingNode.querySelector('.address > div:nth-child(1)');
                    const cityNode = listingNode.querySelector('.address > div:nth-child(2)');
                    const imageUrl = listingNode.querySelector('img[itemprop="image"]').src.replace(/&w=\d+&h=\d+&/, '&w=640&h=480&');
                    const price = parseInt(listingNode.querySelector('[itemprop="price"]').getAttribute('content'));

                    if (price < minPrice || price > maxPrice) {
                        continue;
                    }

                    listings['centris-' + listingId] = {
                        id: 'centris-' + listingId,
                        price: parseInt(listingNode.querySelector('[itemprop="price"]').getAttribute('content')),
                        city: cityNode ? cityNode.textContent.trim() : null,
                        address: addressNode ? addressNode.textContent.trim() : null,
                        description: '',
                        imageUrl: imageUrl,
                        url: detailsLinkNode.href,
                        dateScanned: todaysDate,
                        source: 'Centris',
                    }
                }

                pageNumber += 1;
            }

            return listings;
        }, config.centris.minPrice, config.centris.maxPrice, todaysDate);

        status = "Finished scanning Centris";
        verbose(`Finished scanning Centris: total of ${Object.keys(scannedListings).length} listings found.`);
    } catch (e) {
        verbose(`An error occured while scanning DuProprio: ${e.message}`);
    }

    return scannedListings;
}

async function sendEmailNotification(newListings) {
    /*
    status = 'Sending email notification';
    const transporter = nodemailer.createTransport({
        host: config.email.host,
        port: config.email.port,
        secure: config.email.secure,
        auth: {
            user: config.email.user,
            pass: config.email.password
        }
    });
    const emailDirectory = path.join(__dirname, 'emails');
    const email = new Email({
        transport: transporter,
        send: true,
        preview: false,
        views: {
            root: emailDirectory
        }
    });

    await email.send({
        template: 'newlisting',
        message: {
            from: 'House Search <automation@domain.com>',
            to: 'your@email.com',
        },
        locals: {
            listings: Object.values(newListings),
            newListingCount: Object.values(newListings).length,
        },
    });
    verbose('Email notification has been sent!');
    */
}

async function getTextContent(element) {
    if (!element) {
        return '';
    }

    return (await (await element.getProperty('textContent')).jsonValue()).trim();
}

async function getTextContentForSelector(selector, parentElement) {
    let element = await parentElement.$(selector);
    return await getTextContent(element);
}

async function getNodeAttribute(node, attributeName) {
    return await page.evaluate((node, attributeName) => node.getAttribute(attributeName), node, attributeName)
}

function formatDate(date = null) {
    if (!date) {
        date = new Date();
    }
    return [date.getFullYear(), (date.getMonth()+1).toString().padStart(2, '0'), date.getDate().toString().padStart(2, '0')].join('-')
}

function verbose(message, extra) {
    extra = typeof extra != 'undefined' ? extra : false;

    if (extra && !extraVerboseMode) {
        return;
    }

    if (verboseMode || extraVerboseMode) {
        console.log(message);
    }
}

async function delay(time) {
   return new Promise(function(resolve) {
       setTimeout(resolve, time)
   });
}

async function endWithError(message) {
    console.log(JSON.stringify({ success: false, message: (typeof message != 'undefined' ? message : ''), status: status }, null, 4));
    await browser.close();
    process.exit(1);
}

async function endWithSuccess(message) {
    console.log(JSON.stringify({ success: true, message: typeof message != 'undefined' ? message : '' }, null, 4));
    await browser.close();
    process.exitCode = 0;
}
