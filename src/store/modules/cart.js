const module = 'cart'
// initial state
// https://developers.e-com.plus/docs/api/#/store/carts
const state = {
  body: {
    _id: null,
    items: []
  },
  checkout: {
    freight: 0,
    discount: 0,
    total: 0,
    freight_calculed: false
  }
}

const mutations = {
  // reset cart body object
  editCart (state, { body }) {
    state.body = {
      ...state.body,
      ...body
    }
  },

  // fix cart subtotal value
  fixCartSubtotal (state) {
    let total = 0
    state.body.items.forEach(item => {
      total += item.price * item.quantity
    })
    state.body.subtotal = total
    // also update total value
    state.checkout.total = getters.checkoutValue(state)
  },

  // find item by ID and remove or edit
  fixCartItem (state, { id, product, remove }) {
    let items = state.body.items
    for (let i = 0; i < items.length; i++) {
      let item = items[i]
      if (item._id === id) {
        // found
        if (product) {
          if (item.variation_id) {
            // search product variation
            let variation = product.variations.find(variation => variation._id === item.variation_id)
            if (!variation) {
              // variation not found
              // force to unavailable
              product.available = false
            } else {
              // merge variation body to product body
              Object.assign(product, variation)
              if (variation.picture_id) {
                let picture = product.pictures.find(({ _id }) => _id === variation.picture_id)
                if (picture) {
                  // set variation picture as first
                  product.pictures[0] = picture
                }
              }
            }
          }

          if (product.available) {
            // fix cart item data
            item.sku = product.sku
            if (!item.name) {
              item.name = product.name
            }
            if (!item.picture || !Object.keys(item.picture).length) {
              if (product.pictures.length) {
                // use first product picture
                item.picture = product.pictures[0]
                delete item.picture._id
                delete item.picture.tag
              }
            }

            // update prices and quantities
            if (!item.keep_item_price) {
              item.price = product.price
              item.currency_id = product.currency_id
              item.currency_symbol = product.currency_symbol
            }
            if (!item.keep_item_quantity) {
              item.max_quantity = product.quantity
              if (item.quantity > item.max_quantity) {
                // fix current in cart quantity to max value
                item.quantity = item.max_quantity
              }
              item.min_quantity = product.min_quantity
              if (item.quantity < item.min_quantity) {
                // fix quantity to min value
                item.quantity = item.min_quantity
              }
            }

            // handle gift wrap
            if (typeof item.gift_wrap === 'object' && item.gift_wrap !== null) {
              // search gift wrap by label on product data
              let gift = product.gift_wraps.find(({ label }) => label === item.gift_wrap.label)
              if (gift) {
                // replace item gift object
                item.gift_wrap = gift
              } else {
                // not a valid gift label
                delete item.gift_wrap
              }
            }

            // save product properties that can be changed on item object
            item._product = {}
            ;[
              /* @TODO: treat properties
              'variations',
              'customizations',
              'loyalty_points',
              'progressive_discount',
              'buy_together',
              ...
              */
              'gift_wraps'
            ].forEach(prop => {
              item._product[prop] = product[prop]
            })
          } else {
            // product unavailable to sell
            remove = true
          }
        }

        if (remove) {
          // remove cart item
          items.splice(i, 1)
        }
        break
      }
    }
  },

  // change cart item quantity by item object
  setCartItemQnt (state, { item, qnt }) {
    item = state.body.items.find(({ _id }) => _id === item._id)
    if (item) {
      item.quantity = qnt
    }
    mutations.fixCartSubtotal(state)
  },

  // remove item by item object
  removeCartItem (state, { item }) {
    mutations.fixCartItem(state, { id: item._id, remove: true })
    mutations.fixCartSubtotal(state)
  }
}

const getters = {
  cart: state => state.body,
  checkout: state => state.checkout,
  checkoutValue: ({ body, checkout }) => body.subtotal + checkout.freight - checkout.discount
}

const actions = {
  // load cart body object
  loadCart ({ commit, state, dispatch }, payload) {
    return new Promise((resolve, reject) => {
      let id = payload.id
      let update = body => {
        commit('editCart', { body })
        dispatch('fixCartItems').finally(() => {
          resolve()
        })
      }
      // test with current state body
      let { items } = state.body

      if (id) {
        // try to get from Store API with cart ID
        dispatch('api', [ 'get', module, id ], { root: true }).then(update)
      } else if (!items.length) {
        // try to load JSON from client storage
        let db = window.localStorage
        if (db) {
          let json = db.getItem('cart')
          if (json) {
            let items
            try {
              let obj = JSON.parse(json)
              items = obj.items
            } catch (err) {
              reject(err)
            }

            if (Array.isArray(items)) {
              // save only items
              let body = {
                items: []
              }
              // generate base Object ID for cart items
              let objectId = ('1' + Date.now()).padEnd(24, '0')
              for (let i = 0; i < items.length; i++) {
                let item = items[i]
                if (typeof item === 'object' && item !== null && item.product_id && item.quantity) {
                  body.items.push(Object.assign(item, {
                    _id: objectId.substring(0, 24 - i.toString().length) + i,
                    // force some properties for security
                    keep_item_quantity: false,
                    keep_item_price: false
                  }))
                }
              }
              // update cart
              update(body)
              return
            }
          }

          // fallback for cart already loaded or no cart
          // force resolve
          resolve()
        } else {
          reject(new Error('Can\'t access HTML5 localStorage'))
        }
      }
    }).catch(err => {
      console.error('Error loading cart:', err)
    })
  },

  // handle products data and update cart items
  fixCartItems ({ commit, state, dispatch, rootGetters }) {
    let promises = []
    state.body.items.forEach((item) => {
      let id = item.product_id
      // abstraction to get product data
      let Product = () => rootGetters.productById(id)
      let product = Product()
      let promise

      if (product.hasOwnProperty('_id')) {
        promise = new Promise((resolve, reject) => {
          if (product.sku) {
            // found
            resolve(product)
          } else {
            // should not goes here
            reject(new Error('Invalid product'))
          }
        })
      } else {
        // try to setup current product
        promise = dispatch('initProduct', { id }, { root: true }).then(() => {
          // product data goes out of date
          // shedule removal
          setTimeout(() => {
            commit('removeProduct', { id: Product()._id }, { root: true })
          }, 5 * 60000)
        })
      }

      promises.push(new Promise(resolve => {
        promise.then(() => {
          // valid product
          commit('fixCartItem', { id: item._id, product: { ...Product() } })
        })
        .catch(() => {
          // probably product not found
          // remove from cart
          commit('fixCartItem', { id: item._id, remove: true })
        })
        .finally(resolve)
      }))
    })

    return Promise.all(promises).then(() => {
      commit('fixCartSubtotal')
      dispatch('saveCart')
    })
  },

  // save cart JSON asynchronously
  saveCart ({ state }) {
    return new Promise(resolve => {
      // try to update local storage
      let db = window.localStorage
      if (db) {
        db.setItem('cart', JSON.stringify(state.body))
      }
      resolve()
    })
  }
}

export default {
  state,
  getters,
  mutations,
  actions
}
